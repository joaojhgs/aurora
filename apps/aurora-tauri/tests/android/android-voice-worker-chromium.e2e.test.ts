// @vitest-environment node

import { existsSync, readdirSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import {
  adbOutputOrEmpty,
  adbReverseMappings,
  assertExpectedAndroidEmulator,
  chromiumChromePackage,
  chromiumChromeTarget,
  cleanupAndroidBrowser,
  createAndroidWebViewShellHarness,
  launchAndroidBrowser,
  packageBaseApkPath,
  packageVersion,
  removeAdbReverseMapping,
  restoreAdbReverseLocals,
  resolveAdb,
  resolveDeviceSerial,
  runAdb,
  sha256DeviceFile,
  type AndroidBrowserClaims,
  type AndroidBrowserRestoreState,
  type AndroidEmulatorMetadata
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
const reverseSentinel = {
  local: 'tcp:39999',
  remote: 'tcp:39999'
}
const expectedWasmFiles = [
  'aurora_voice_wasm.d.ts',
  'aurora_voice_wasm.js',
  'aurora_voice_wasm_bg.wasm',
  'aurora_voice_wasm_bg.wasm.d.ts'
]
const successFrontierUrls = new Set([
  '/index.html',
  '/__aurora_voice_harness__.js',
  '/dist/browser.js',
  '/dist/voice-worker.js',
  '/dist/wasm/aurora_voice_wasm_bg.wasm',
  '/__aurora_artifacts__',
  '/__aurora_requests__'
])
const expectedSuccessFrontier = [
  '/index.html',
  '/__aurora_voice_harness__.js',
  '/dist/browser.js',
  '/dist/voice-worker.js',
  '/dist/wasm/aurora_voice_wasm_bg.wasm',
  '/dist/voice-worker.js',
  '/dist/wasm/aurora_voice_wasm_bg.wasm',
  '/dist/voice-worker.js',
  '/dist/wasm/aurora_voice_wasm_bg.wasm',
  '/__aurora_artifacts__',
  '/__aurora_requests__'
]
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
      const adb = resolveAdb()
      const serial = resolveDeviceSerial()
      const emulator = assertExpectedAndroidEmulator(adb, serial)
      const originalReverseMappings = adbReverseMappings(adb, serial)
      removeAdbReverseMapping(adb, serial, reverseSentinel.local)
      runAdb(adb, serial, ['reverse', reverseSentinel.local, reverseSentinel.remote])
      const sentinelReverseMapping = requiredReverseMapping(adbReverseMappings(adb, serial), reverseSentinel.local)
      cleanup = async () => {
        restoreAdbReverseLocals(adb, serial, originalReverseMappings, [reverseSentinel.local])
      }
      const resources = await createResources(adb, serial, emulator)
      cleanup = async () => {
        try {
          await resources.close()
        } finally {
          restoreAdbReverseLocals(adb, serial, originalReverseMappings, [reverseSentinel.local])
        }
      }

      const result = await waitForSelfReportedProof(resources)
      if (isFailedSelfReport(result)) {
        throw new Error(`Android Chromium harness failed: ${result.error.message}\n${result.error.stack ?? ''}`)
      }
      const metadata = await readHostMetadata(resources.adb, resources.serial, resources.emulator, result.selfReported)

      expect(metadata).toEqual({
        deviceSerial: resources.serial,
        emulator: resources.emulator,
        sdk: '35',
        release: '15',
        cpuAbi: 'x86_64',
        fingerprint: resources.emulator.fingerprint,
        browserPackage: chromiumChromePackage,
        browserVersion: expectedChromiumVersion,
        browserActivity: chromiumChromeTarget.activityName,
        apkPath: metadata.apkPath,
        snapshotSource: expectedChromiumSnapshot.source,
        apkSha256: expectedChromiumSnapshot.apkSha256,
        userAgent: result.selfReported.userAgent,
        targetUrl: `${resources.harness.baseUrl}/`
      })
      expect(metadata.userAgent).toContain('Android')
      expect(metadata.userAgent).toContain('Chrome/153.0.0.0')
      expect(metadata.targetUrl).toBe(`${resources.harness.baseUrl}/`)
      expect(result.selfReported).toEqual({
        userAgent: result.selfReported.userAgent,
        href: `${resources.harness.baseUrl}/`,
        readyState: 'complete',
        runtimePath: 'self-reporting-page'
      })
      expect(result.claims).toEqual(chromiumClaims)
      expect(result.artifacts).toEqual({
        servedDist: true,
        workerRequested: true,
        wasmRequested: true,
        exactWasmInventory: true,
        wasmCoreWithinLimit: true,
        wasmLoaderWithinLimit: true,
        wasmFiles: expectedWasmFiles,
        wasmSizes: expectedWasmSizes(),
        forbiddenArtifactCount: 0,
        fileCount: expectedDistFileCount()
      })
      expect(result.artifacts.wasmFiles).toEqual(expectedWasmFiles)
      expect(successFrontier(result.requests)).toEqual(expectedSuccessFrontier)

      assertCompleteRepeat(result.completeRepeat, 'android-chromium')
      assertAbandonRepeat(result.abandonRepeat, 'android-chromium')
      assertRedaction(result.redaction)
      expect(result.leakScan).toEqual({
        eventLeak: false,
        snapshotLeak: false,
        consoleLeak: false,
        rawPcmLeak: false,
        transcriptLeak: false
      })
      expect(result.consoleErrors).toEqual([])
      expect(result.workerSideErrors).toEqual([])

      try {
        await resources.close()
        expect(adbReverseMappings(resources.adb, resources.serial)).toEqual(resources.restoreState.reverseMappings)
        expect(resources.restoreState.reverseMappings.filter((mapping) => mapping.local === reverseSentinel.local)).toEqual([sentinelReverseMapping])
      } finally {
        restoreAdbReverseLocals(adb, serial, originalReverseMappings, [reverseSentinel.local])
        cleanup = undefined
      }
      expect(adbReverseMappings(resources.adb, resources.serial)).toEqual(originalReverseMappings)
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

async function createResources(adb = resolveAdb(), serial = resolveDeviceSerial(), emulator = assertExpectedAndroidEmulator(adb, serial)) {
  const harness = await createAndroidWebViewShellHarness(voiceWebRoot, {
    claims: chromiumClaims,
    harnessPrefix: 'android-chromium'
  })
  const reversedPorts: number[] = []
  let restoreState: AndroidBrowserRestoreState | undefined
  let closed = false

  try {
    const port = Number(new URL(harness.baseUrl).port)
    const priorReverseMappings = adbReverseMappings(adb, serial)
    removeAdbReverseMapping(adb, serial, `tcp:${port}`)
    runAdb(adb, serial, ['reverse', `tcp:${port}`, `tcp:${port}`])
    reversedPorts.push(port)
    const browserRestoreState = launchAndroidBrowser(adb, serial, chromiumChromeTarget, `${harness.baseUrl}/`)
    restoreState = {
      ...browserRestoreState,
      reverseMappings: priorReverseMappings
    }
    return {
      adb,
      serial,
      emulator,
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

async function readHostMetadata(adb: string, serial: string, emulator: AndroidEmulatorMetadata, selfReported: SelfReportedPage) {
  const apkPath = packageBaseApkPath(adb, serial, chromiumChromePackage)
  const apkSha256 = await sha256DeviceFile(adb, serial, apkPath)
  if (apkSha256 !== expectedChromiumSnapshot.apkSha256) {
    throw new Error(`Installed Chromium APK hash mismatch for ${apkPath}: expected ${expectedChromiumSnapshot.apkSha256}, got ${apkSha256}`)
  }
  return {
    deviceSerial: serial,
    emulator,
    sdk: emulator.sdk,
    release: emulator.release,
    cpuAbi: emulator.cpuAbi,
    fingerprint: emulator.fingerprint,
    browserPackage: chromiumChromePackage,
    browserVersion: packageVersion(adb, serial, chromiumChromePackage),
    browserActivity: chromiumChromeTarget.activityName,
    apkPath,
    userAgent: selfReported.userAgent,
    targetUrl: selfReported.href,
    snapshotSource: expectedChromiumSnapshot.source,
    apkSha256
  }
}

function assertCompleteRepeat(completeRepeat: any, prefix: string): void {
  expect(completeRepeat.first).toEqual({
    ownerId: `${prefix}-complete`,
    sessionId: `${prefix}-complete:1`,
    generation: 1,
    startedAtMs: expect.any(Number),
    foregroundOnly: true
  })
  expect(completeRepeat.firstAudio).toEqual({
    sessionId: `${prefix}-complete:1`,
    generation: 1,
    sampleRateHz: 16_000,
    channels: 1,
    sampleCount: 6,
    durationMs: expect.any(Number),
    pcm: [100, -100, 200, -200, 321, -321],
    redacted: true
  })
  expect(completeRepeat.stoppedSnapshot).toEqual(expectedSnapshot(`${prefix}-complete`, 'stopped', `${prefix}-complete:1`, 1, 0, 0))
  expect(completeRepeat.completedSnapshot).toEqual(expectedSnapshot(`${prefix}-complete`, 'idle', null, 1, 0, 0))
  expect(completeRepeat.second).toEqual({
    ownerId: `${prefix}-complete`,
    sessionId: `${prefix}-complete:2`,
    generation: 2,
    startedAtMs: expect.any(Number),
    foregroundOnly: true
  })
  expect(completeRepeat.secondAudio).toEqual({
    sessionId: `${prefix}-complete:2`,
    generation: 2,
    sampleRateHz: 16_000,
    channels: 1,
    sampleCount: 3,
    durationMs: expect.any(Number),
    pcm: [7, 8, 9],
    redacted: true
  })
  expect(completeRepeat.finalSnapshot).toEqual(expectedSnapshot(`${prefix}-complete`, 'idle', null, 2, 0, 0))
  expect(completeRepeat.events).toEqual([
    expectedEvent('session_started', `${prefix}-complete`, `${prefix}-complete:1`, 1, null, 0, 0, 0, null),
    expectedEvent('frame_accepted', `${prefix}-complete`, `${prefix}-complete:1`, 1, 0, 4, 8, 0, null),
    expectedEvent('frame_accepted', `${prefix}-complete`, `${prefix}-complete:1`, 1, 1, 2, 4, 0, null),
    expectedEvent('session_stopped', `${prefix}-complete`, `${prefix}-complete:1`, 1, null, 0, 0, 0, 'stopped'),
    expectedEvent('session_started', `${prefix}-complete`, `${prefix}-complete:2`, 2, null, 0, 0, 0, null),
    expectedEvent('frame_accepted', `${prefix}-complete`, `${prefix}-complete:2`, 2, 0, 3, 6, 0, null),
    expectedEvent('session_stopped', `${prefix}-complete`, `${prefix}-complete:2`, 2, null, 0, 0, 0, 'stopped')
  ])
}

function assertAbandonRepeat(abandonRepeat: any, prefix: string): void {
  expect(abandonRepeat.first).toEqual({
    ownerId: `${prefix}-abandon`,
    sessionId: `${prefix}-abandon:1`,
    generation: 1,
    startedAtMs: expect.any(Number),
    foregroundOnly: true
  })
  expect(abandonRepeat.firstAudio).toEqual({ sampleCount: 4, redacted: true })
  expect(abandonRepeat.abandonedSnapshot).toEqual(expectedSnapshot(`${prefix}-abandon`, 'cancelled', null, 1, 0, 0))
  expect(abandonRepeat.second).toEqual({
    ownerId: `${prefix}-abandon`,
    sessionId: `${prefix}-abandon:2`,
    generation: 2,
    startedAtMs: expect.any(Number),
    foregroundOnly: true
  })
  expect(abandonRepeat.secondAudio).toEqual({ sampleCount: 2, redacted: true })
  expect(abandonRepeat.finalSnapshot).toEqual(expectedSnapshot(`${prefix}-abandon`, 'idle', null, 2, 0, 0))
  expect(abandonRepeat.events).toEqual([
    expectedEvent('session_started', `${prefix}-abandon`, `${prefix}-abandon:1`, 1, null, 0, 0, 0, null),
    expectedEvent('frame_accepted', `${prefix}-abandon`, `${prefix}-abandon:1`, 1, 0, 4, 8, 0, null),
    expectedEvent('session_stopped', `${prefix}-abandon`, `${prefix}-abandon:1`, 1, null, 0, 0, 0, 'stopped'),
    expectedEvent('session_started', `${prefix}-abandon`, `${prefix}-abandon:2`, 2, null, 0, 0, 0, null),
    expectedEvent('frame_accepted', `${prefix}-abandon`, `${prefix}-abandon:2`, 2, 0, 2, 4, 0, null),
    expectedEvent('session_stopped', `${prefix}-abandon`, `${prefix}-abandon:2`, 2, null, 0, 0, 0, 'stopped')
  ])
}

function assertRedaction(redaction: any): void {
  expect(redaction.snapshots).toEqual([
    expectedSnapshot(`${'android-chromium'}-redacted`, 'idle', null, 0, 0, 0),
    expectedSnapshot(`${'android-chromium'}-redacted`, 'active', 'android-chromium-redacted:1', 1, 1, 0),
    expectedSnapshot(`${'android-chromium'}-redacted`, 'stopped', 'android-chromium-redacted:1', 1, 0, 0),
    expectedSnapshot(`${'android-chromium'}-redacted`, 'idle', null, 1, 0, 0)
  ])
  for (const snapshot of redaction.snapshots) {
    expect(snapshot).not.toHaveProperty('pcm')
    expect(snapshot).not.toHaveProperty('transcript')
  }
  expect(redaction.captured).toEqual({ sampleCount: 2, redacted: true })
  expect(redaction.events).toEqual([
    expectedEvent('session_started', 'android-chromium-redacted', 'android-chromium-redacted:1', 1, null, 0, 0, 0, null),
    expectedEvent('frame_accepted', 'android-chromium-redacted', 'android-chromium-redacted:1', 1, 0, 2, 4, 0, null),
    expectedEvent('session_stopped', 'android-chromium-redacted', 'android-chromium-redacted:1', 1, null, 0, 0, 0, 'stopped')
  ])
}

function expectedSnapshot(ownerId: string, state: string, sessionId: string | null, generation: number, nextSequence: number, queuedBytes: number) {
  return {
    ownerId,
    sessionId,
    generation,
    nextSequence,
    queuedBytes,
    state,
    capabilities: { vad: false, kws: false, stt: false, tts: false },
    lifecycle: {
      foregroundOnly: true,
      visible: true,
      frozen: false,
      eligible: true,
      reason: 'visible'
    }
  }
}

function expectedWasmSizes(): Record<string, number> {
  return Object.fromEntries(expectedWasmFiles.map((file) => [file, statSync(join(voiceWebDist, 'wasm', file)).size]))
}

function expectedDistFileCount(): number {
  return countFiles(voiceWebDist)
}

function countFiles(root: string): number {
  return readdirSync(root).reduce((count, name) => {
    const path = join(root, name)
    return count + (statSync(path).isDirectory() ? countFiles(path) : 1)
  }, 0)
}

function successFrontier(requests: readonly string[]): readonly string[] {
  return requests.filter((request) => successFrontierUrls.has(request))
}

function requiredReverseMapping(mappings: readonly { readonly local: string }[], local: string) {
  const mapping = mappings.find((candidate) => candidate.local === local)
  if (mapping === undefined) throw new Error(`Missing expected adb reverse mapping for ${local}`)
  return mapping
}

function expectedEvent(
  kind: string,
  ownerId: string,
  sessionId: string | null,
  generation: number,
  sequence: number | null,
  sampleCount: number,
  byteLength: number,
  queuedBytes: number,
  reason: string | null
) {
  return {
    kind,
    ownerId,
    sessionId,
    generation,
    sequence,
    sampleCount,
    byteLength,
    queuedBytes,
    reason,
    redacted: true,
    occurredAtMs: expect.any(Number)
  }
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
    readonly fileCount: number
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
