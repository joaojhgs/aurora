// @vitest-environment node

import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import {
  adbOutputOrEmpty,
  adbReverseMappings,
  assertExpectedAndroidEmulator,
  captureAndroidBrowserState,
  cleanupWebViewShell,
  createAndroidWebViewShellHarness,
  launchAndroidBrowser,
  packageVersion,
  resolveAdb,
  resolveDeviceSerial,
  runAdb,
  webViewShellTarget,
  type AndroidBrowserRestoreState,
  type AndroidEmulatorMetadata,
  type AndroidWebViewShellMetadata
} from './android-webview-shell-harness-utils.js'

const repoRoot = resolve(import.meta.dirname, '../../../..')
const voiceWebRoot = resolve(repoRoot, 'packages/aurora-voice-web')
const voiceWebDist = resolve(voiceWebRoot, 'dist')
const testTimeoutMs = Number(process.env.AURORA_ANDROID_VOICE_WEBVIEW_TIMEOUT_MS ?? 180_000)
const enginePreflightTimeoutMs = Number(process.env.AURORA_ANDROID_WEBVIEW_ENGINE_PREFLIGHT_TIMEOUT_MS ?? 45_000)

let cleanup: (() => Promise<void>) | undefined

afterEach(async () => {
  await cleanup?.()
  cleanup = undefined
})

describe('Android WebView Shell production voice Worker/WASM bridge', () => {
  it(
    'runs the built browser entry through module Worker and generated Rust/WASM start frame stop complete abandon repeat',
    async () => {
      assertBuiltProductionVoiceArtifacts()
      await assertWebViewShellModuleScriptCanSelfReport()
      const resources = await createResources()
      cleanup = resources.close

      const result = await waitForSelfReportedProof(resources)
      if (isFailedSelfReport(result)) {
        throw new Error(`Android WebView Shell harness failed: ${result.error.message}\n${result.error.stack ?? ''}`)
      }
      const metadata = readHostMetadata(resources.adb, resources.serial, resources.emulator, result.selfReported)

      expect(metadata).toMatchObject({
        deviceSerial: resources.serial,
        sdk: '35',
        release: '15',
        cpuAbi: 'x86_64',
        webViewPackage: 'com.android.webview',
        shellPackage: 'org.chromium.webview_shell'
      })
      expect(metadata.browserVersion).toMatch(/^Chrome\/124\./u)
      expect(metadata.userAgent).toContain('; wv)')
      expect(metadata.userAgent).toContain('Android 15')
      expect(metadata.targetUrl).toBe(`${resources.harness.baseUrl}/`)
      expect(result.selfReported).toMatchObject({
        href: `${resources.harness.baseUrl}/`,
        runtimePath: 'self-reporting-page'
      })
      expect(result.claims).toEqual({
        browserSurface: 'Android emulator WebView Shell',
        package: 'org.chromium.webview_shell',
        physicalDevice: false,
        chromePackage: false,
        mockedWorker: false,
        mockedWasm: false,
        pcmSource: 'deterministic injected Int16Array source',
        microphonePermission: false,
        acousticCapture: false
      })
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
        '/dist/browser.js',
        '/dist/voice-worker.js',
        '/dist/wasm/aurora_voice_wasm.js',
        '/dist/wasm/aurora_voice_wasm_bg.wasm'
      ]))

      expect(result.completeRepeat.first).toMatchObject({
        ownerId: 'android-webview-complete',
        sessionId: 'android-webview-complete:1',
        generation: 1,
        foregroundOnly: true
      })
      expect(result.completeRepeat.firstAudio).toMatchObject({
        sessionId: 'android-webview-complete:1',
        generation: 1,
        sampleRateHz: 16_000,
        channels: 1,
        sampleCount: 6,
        pcm: [100, -100, 200, -200, 321, -321],
        redacted: true
      })
      expect(result.completeRepeat.stoppedSnapshot).toMatchObject({
        state: 'stopped',
        sessionId: 'android-webview-complete:1',
        generation: 1,
        capabilities: { vad: false, kws: false, stt: false, tts: false }
      })
      expect(result.completeRepeat.completedSnapshot).toMatchObject({
        state: 'idle',
        sessionId: null,
        generation: 1,
        capabilities: { vad: false, kws: false, stt: false, tts: false }
      })
      expect(result.completeRepeat.second).toMatchObject({
        sessionId: 'android-webview-complete:2',
        generation: 2
      })
      expect(result.completeRepeat.secondAudio).toMatchObject({
        sessionId: 'android-webview-complete:2',
        generation: 2,
        sampleCount: 3,
        pcm: [7, 8, 9],
        redacted: true
      })
      expect(result.completeRepeat.finalSnapshot).toMatchObject({
        state: 'idle',
        sessionId: null,
        generation: 2,
        queuedBytes: 0,
        capabilities: { vad: false, kws: false, stt: false, tts: false }
      })
      expect(result.completeRepeat.events.map((event) => event.kind)).toEqual([
        'session_started',
        'frame_accepted',
        'frame_accepted',
        'session_stopped',
        'session_started',
        'frame_accepted',
        'session_stopped'
      ])
      expect(result.completeRepeat.events.every((event) => event.redacted === true)).toBe(true)
      expect(result.completeRepeat.events.some((event) => event.kind === 'error')).toBe(false)

      expect(result.abandonRepeat.first).toMatchObject({
        sessionId: 'android-webview-abandon:1',
        generation: 1
      })
      expect(result.abandonRepeat.firstAudio).toEqual({ sampleCount: 4, redacted: true })
      expect(result.abandonRepeat.abandonedSnapshot).toMatchObject({
        state: 'cancelled',
        sessionId: null,
        generation: 1,
        capabilities: { vad: false, kws: false, stt: false, tts: false }
      })
      expect(result.abandonRepeat.second).toMatchObject({
        sessionId: 'android-webview-abandon:2',
        generation: 2
      })
      expect(result.abandonRepeat.secondAudio).toEqual({ sampleCount: 2, redacted: true })
      expect(result.abandonRepeat.finalSnapshot).toMatchObject({
        state: 'idle',
        sessionId: null,
        generation: 2,
        queuedBytes: 0,
        capabilities: { vad: false, kws: false, stt: false, tts: false }
      })
      expect(result.abandonRepeat.events.every((event) => event.redacted === true)).toBe(true)
      expect(result.abandonRepeat.events.some((event) => event.kind === 'error')).toBe(false)

      for (const snapshot of result.redaction.snapshots) {
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
      expect(result.redaction.captured).toEqual({ sampleCount: 2, redacted: true })
      expect(result.leakScan).toMatchObject({
        eventLeak: false,
        snapshotLeak: false,
        consoleLeak: false,
        rawPcmLeak: false,
        transcriptLeak: false
      })
      expect(result.consoleErrors).toEqual([])
      expect(result.workerSideErrors).toEqual([])
    },
    Math.max(300_000, testTimeoutMs + 120_000)
  )
})

async function assertWebViewShellModuleScriptCanSelfReport(): Promise<void> {
  const resources = await createResources({
    indexHtml: `<!doctype html><meta charset="utf-8"><link rel="icon" href="data:,"><title>Aurora Android WebView Shell preflight</title><body>running<script type="module">
      await fetch('/__aurora_result__', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          ok: true,
          probe: 'module-script-preflight',
          selfReported: {
            userAgent: navigator.userAgent,
            href: location.href,
            readyState: document.readyState,
            runtimePath: 'self-reporting-page'
          }
        })
      });
      document.body.textContent = 'passed';
    </script></body>`
  })
  try {
    const result = await resources.harness.waitForResult<ModuleScriptPreflightResult>(enginePreflightTimeoutMs)
    if (result.ok !== true) {
      throw new Error(`module-script preflight returned ${JSON.stringify(result)}`)
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    const logcat = filteredWebViewLogcat(resources.adb, resources.serial)
    throw new Error([
      'Android WebView Shell engine blocked before Aurora voice harness execution.',
      `Module-script self-report did not complete: ${message}`,
      `Request frontier: ${JSON.stringify(resources.harness.requests)}`,
      'No Aurora harness, module Worker, or WASM artifact was requested.',
      `WebView logcat:\n${logcat}`
    ].join('\n'))
  } finally {
    await resources.close()
  }
}

async function createResources(options: Parameters<typeof createAndroidWebViewShellHarness>[1] = {}) {
  const adb = resolveAdb()
  const serial = resolveDeviceSerial()
  const emulator = assertExpectedAndroidEmulator(adb, serial)
  const harness = await createAndroidWebViewShellHarness(voiceWebRoot, options)
  const reversedPorts: number[] = []
  let restoreState: AndroidBrowserRestoreState | undefined
  let closed = false

  try {
    const port = Number(new URL(harness.baseUrl).port)
    const priorReverseMappings = adbReverseMappings(adb, serial)
    restoreState = {
      ...captureAndroidBrowserState(adb, serial, webViewShellTarget),
      reverseMappings: priorReverseMappings
    }
    reversedPorts.push(port)
    runAdb(adb, serial, ['reverse', '--remove', `tcp:${port}`])
    runAdb(adb, serial, ['reverse', `tcp:${port}`, `tcp:${port}`])
    launchAndroidBrowser(adb, serial, webViewShellTarget, `${harness.baseUrl}/`)
    return {
      adb,
      serial,
      emulator,
      harness,
      async close() {
        if (closed) return
        closed = true
        cleanupWebViewShell(adb, serial, reversedPorts, restoreState)
        await harness.close()
      }
    }
  } catch (error) {
    cleanupWebViewShell(adb, serial, reversedPorts, restoreState)
    await harness.close()
    throw error
  }
}

async function waitForSelfReportedProof(resources: Awaited<ReturnType<typeof createResources>>): Promise<AndroidVoiceWebViewProof | FailedSelfReport> {
  try {
    return await resources.harness.waitForResult<AndroidVoiceWebViewProof | FailedSelfReport>(testTimeoutMs)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new Error([
      message,
      `Request frontier: ${JSON.stringify(resources.harness.requests)}`,
      `WebView logcat:\n${filteredWebViewLogcat(resources.adb, resources.serial)}`
    ].join('\n'))
  }
}

function filteredWebViewLogcat(adb: string, serial: string): string {
  return adbOutputOrEmpty(adb, serial, ['logcat', '-d'])
    .split('\n')
    .filter((line) => !/ F crashpad: /u.test(line))
    .filter((line) => /org\.chromium\.webview_shell|com\.android\.webview|CrRendererMain|Renderer process|SIGTRAP|Fatal signal|aw_browser_terminator|incorrect payload|Cmdline:|signal 5/u.test(line))
    .slice(-120)
    .join('\n')
    .slice(-16_000)
}

function readHostMetadata(adb: string, serial: string, emulator: AndroidEmulatorMetadata, selfReported: SelfReportedPage): AndroidWebViewShellMetadata {
  const webViewVersion = packageVersion(adb, serial, 'com.android.webview')
  return {
    deviceSerial: serial,
    sdk: emulator.sdk,
    release: emulator.release,
    cpuAbi: emulator.cpuAbi,
    fingerprint: emulator.fingerprint,
    webViewPackage: 'com.android.webview',
    webViewVersion,
    shellPackage: 'org.chromium.webview_shell',
    shellVersion: packageVersion(adb, serial, 'org.chromium.webview_shell'),
    browserVersion: `Chrome/${webViewVersion}`,
    userAgent: selfReported.userAgent,
    targetUrl: selfReported.href
  }
}

function isFailedSelfReport(result: AndroidVoiceWebViewProof | FailedSelfReport): result is FailedSelfReport {
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

interface ModuleScriptPreflightResult {
  readonly ok: true
  readonly probe: 'module-script-preflight'
  readonly selfReported: SelfReportedPage
}

interface AndroidVoiceWebViewProof {
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
  readonly claims: {
    readonly browserSurface: string
    readonly package: string
    readonly physicalDevice: boolean
    readonly chromePackage: boolean
    readonly mockedWorker: boolean
    readonly mockedWasm: boolean
    readonly pcmSource: string
    readonly microphonePermission: boolean
    readonly acousticCapture: boolean
  }
  readonly workerSideErrors: readonly unknown[]
  readonly leakScan: {
    readonly eventLeak: boolean
    readonly snapshotLeak: boolean
    readonly consoleLeak: boolean
    readonly rawPcmLeak: boolean
    readonly transcriptLeak: boolean
  }
}
