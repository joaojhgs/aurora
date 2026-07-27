// @vitest-environment node

import {
  spawn,
  spawnSync,
  type ChildProcessWithoutNullStreams,
} from 'node:child_process'
import crypto from 'node:crypto'
import { existsSync, statSync } from 'node:fs'
import fs from 'node:fs/promises'
import http, {
  type IncomingMessage,
  type ServerResponse,
} from 'node:http'
import net from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'

import {
  assertNoInteropSeededSecrets,
  assertInteropBrowserResult,
  redactInteropArtifactValue,
  redactInteropSeededText,
  type InteropBrowserResult,
} from '../../../../tests/e2e/webrtc_interop/assertions.js'

type BrowserConfig = {
  lane: string
  brokerUrl: string
  expectedStablePeerId: string
  expectedNegotiationRole: 'offerer' | 'answerer'
  timeoutMs: number
  [key: string]: unknown
}

type MobileResult = {
  ok: boolean
  result?: InteropBrowserResult
  error?: {
    name?: string
    message?: string
    stack?: string
  }
  consoleErrors?: string[]
}

type SimulatorDevice = {
  name: string
  udid: string
  state: string
  runtime: string
}

type WkWebViewArtifactProof = {
  checkedEntries: number
  forbiddenMatchCount: 0
  pythonSidecarPackaged: false
}

type IosInteropSurface = {
  id: 'mobile-safari' | 'tauri-wkwebview'
  testName: string
  browserName: string
  artifactDir: string
  artifactPrefix: string
  command: string
  observation: string
}

const repoRoot = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../../..',
)
const appRoot = resolve(repoRoot, 'apps/aurora-tauri')
const gatewayScript = resolve(
  repoRoot,
  'scripts/webrtc_interop_gateway.py',
)
const scannerScript = resolve(
  repoRoot,
  'scripts/webrtc_interop_scan.py',
)
const browserEntry = resolve(
  repoRoot,
  'tests/e2e/webrtc_interop/browser-entry.ts',
)
const mqttEntry = resolve(
  repoRoot,
  'tests/e2e/webrtc_interop/mqtt-entry.ts',
)
const cryptoWorkerEntry = resolve(
  repoRoot,
  'packages/aurora-sdk/src/webrtc/crypto-worker.ts',
)
const surfaces: IosInteropSurface[] = [
  {
    id: 'mobile-safari',
    testName:
      'pairs MobileSafari in an iOS simulator with an external Python peer without HTTP transport fallback',
    browserName: 'ios-mobile-safari-simulator',
    artifactDir:
      process.env.AURORA_IOS_MOBILE_WEBRTC_ARTIFACT_DIR ??
      resolve(
        appRoot,
        'reports/webrtc-interop/ios-mobile-safari',
      ),
    artifactPrefix: 'ios-mobile-safari',
    command:
      'pnpm --filter @aurora/tauri-ui ios:webrtc:interop',
    observation:
      'auto-running same-origin harness in MobileSafari; application fetches are instrumented inside the WebRTC runtime and the result callback runs only after runtime close',
  },
  {
    id: 'tauri-wkwebview',
    testName:
      'pairs a packaged Tauri WKWebView simulator app with an external Python peer without HTTP transport fallback',
    browserName: 'ios-tauri-wkwebview-simulator',
    artifactDir:
      process.env.AURORA_IOS_WKWEBVIEW_WEBRTC_ARTIFACT_DIR ??
      resolve(appRoot, 'reports/webrtc-interop/ios-wkwebview'),
    artifactPrefix: 'ios-wkwebview',
    command:
      'pnpm --filter @aurora/tauri-ui ios:webrtc:interop',
    observation:
      'auto-running harness embedded in a dedicated unsigned Tauri iOS simulator app; loopback HTTP is test control only, while Aurora application RPC and events remain on the WebRTC DataChannel with the Python HTTP API disabled',
  },
]
// Cold simulator WebKit startup plus the full reconnect/revocation proof can
// exceed three minutes on shared macOS runners.
const interopTimeoutMs = Number(
  process.env.AURORA_IOS_MOBILE_WEBRTC_TIMEOUT_MS ?? 600_000,
)
const testTimeoutMs = Math.max(900_000, interopTimeoutMs + 180_000)
const safariBundleId = 'com.apple.mobilesafari'
const describeOnMac = process.platform === 'darwin' ? describe : describe.skip

let cleanup: (() => Promise<void>) | undefined

afterEach(async () => {
  await cleanup?.()
  cleanup = undefined
})

describeOnMac('iOS browser and packaged WKWebView WebRTC interoperability', () => {
  for (const surface of surfaces) {
    it(surface.testName, () => runIosInterop(surface), testTimeoutMs)
  }
})

async function runIosInterop(surface: IosInteropSurface): Promise<void> {
  const resources = await createInteropResources(surface)
  cleanup = resources.close
  const started = Date.now()
  let mobileResult: MobileResult | undefined
  try {
    const ready = await waitForJson<BrowserConfig>(
      resources.readyPath,
      resources.timeoutMs,
      'Python peer readiness',
      resources.pythonPeer,
      resources.getPythonOutput,
    )
    resources.setReadyConfig(ready)
    await resources.launchBrowser()

    mobileResult = await resources.waitForMobileResult(
      resources.timeoutMs,
    )
    if (!mobileResult.ok || !mobileResult.result) {
      throw new Error(
        mobileResult.error?.stack ||
          mobileResult.error?.message ||
          `${surface.browserName} reported an unknown interop failure`,
      )
    }

    const browserResult = mobileResult.result
    resources.assertNoSeededSecrets(browserResult)
    assertInteropBrowserResult(browserResult, {
      lane: 'direct',
      expectedStablePeerId: ready.expectedStablePeerId,
      expectedNegotiationRole: ready.expectedNegotiationRole,
    })
    expect(mobileResult.consoleErrors ?? []).toEqual([])

    await resources.captureSimulatorEvidence()
    await writeJson(resources.browserReportPath, {
      lane: 'direct',
      browserName: surface.browserName,
      status: 'passed',
      durationMs: Date.now() - started,
      command: surface.command,
      browserResult,
      noHttpFetchTransportUsed: true,
      observation: surface.observation,
      consoleErrors: mobileResult.consoleErrors ?? [],
      simulator: resources.simulator,
      surface: resources.surfaceEvidence,
      screenshotPath: `<artifact-dir>/${surface.artifactPrefix}.png`,
      logPath: `<artifact-dir>/${surface.artifactPrefix}.log`,
      reportDigest: crypto
        .createHash('sha256')
        .update(JSON.stringify(browserResult))
        .digest('hex'),
      secretsRedacted: true,
    })
    await writeJson(resources.donePath, {
      ok: true,
      at: new Date().toISOString(),
    })

    await waitForChild(resources.pythonPeer, 30_000)
    const pythonReport = await waitForJson<Record<string, unknown>>(
      resources.pythonReportPath,
      10_000,
      'Python peer report',
    )
    resources.assertNoSeededSecrets(pythonReport)
    expect(pythonReport).toMatchObject({
      gatewayHttpApiEnabled: false,
      rtcStarted: true,
      eventSent: true,
      ttsEventSent: true,
      revoked: true,
      secretsRedacted: true,
    })

    run(
      'uv',
      [
        'run',
        'python',
        scannerScript,
        '--artifact-dir',
        resources.artifactDir,
        '--python-report',
        resources.pythonReportPath,
        '--browser-report',
        resources.browserReportPath,
        '--out',
        resources.finalReportPath,
        '--lane',
        'direct',
      ],
      repoRoot,
    )
    const aggregate = await waitForJson<Record<string, unknown>>(
      resources.finalReportPath,
      10_000,
      `aggregate ${surface.browserName} WebRTC report`,
    )
    resources.assertNoSeededSecrets(aggregate)
    expect(aggregate).toMatchObject({
      status: 'passed',
      lane: 'direct',
      pathCategoryAccepted: true,
      secretsRedacted: true,
    })
  } catch (error) {
    await resources.captureSimulatorEvidence().catch(() => undefined)
    const redactedError = resources.redactArtifactValue(
      error instanceof Error ? error.message : String(error),
    )
    const failureReport = resources.redactArtifactValue({
      lane: 'direct',
      browserName: surface.browserName,
      status: 'failed',
      durationMs: Date.now() - started,
      error: redactedError,
      mobileResult,
      simulator: resources.simulator,
      surface: resources.surfaceEvidence,
      secretsRedacted: true,
    })
    resources.assertNoSeededSecrets(failureReport)
    await writeJson(resources.browserReportPath, failureReport)
    await writeJson(resources.donePath, {
      ok: false,
      at: new Date().toISOString(),
    })
    throw new Error(redactedError)
  }
}

async function createInteropResources(surface: IosInteropSurface) {
  assertCommandAvailable('xcrun', ['--version'])
  assertCommandAvailable('mosquitto', ['-h'])

  const timeoutMs = interopTimeoutMs
  const artifactDir = surface.artifactDir
  const roomSecret = crypto.randomBytes(32).toString('base64url')
  const token = `ios-${surface.id}.${crypto
    .randomBytes(24)
    .toString('base64url')}`
  const seededSecrets = [roomSecret, token]
  const room = `ios-${surface.id}-${process.pid}-${Date.now().toString(36)}`
  const brokerPort = await allocateTcpPort()
  const readyPath = join(artifactDir, 'gateway-ready.json')
  const donePath = join(
    artifactDir,
    `${surface.artifactPrefix}-done.json`,
  )
  const pythonReportPath = join(
    artifactDir,
    'python-gateway-report.json',
  )
  const browserReportPath = join(
    artifactDir,
    `${surface.artifactPrefix}-browser-report.json`,
  )
  const finalReportPath = join(artifactDir, 'report.json')
  const bundlePath = join(
    artifactDir,
    'ios-mobile-browser-bundle.js',
  )
  const mqttBundlePath = join(artifactDir, 'mqtt-bundle.mjs')
  const cryptoWorkerBundlePath = join(
    artifactDir,
    'crypto-worker-bundle.js',
  )
  const mosquittoConfigPath = join(
    artifactDir,
    'mosquitto-ios-interop.conf',
  )
  const mosquittoLogPath = join(
    artifactDir,
    'mosquitto-ios-interop.log',
  )
  const simulatorLogPath = join(
    artifactDir,
    `${surface.artifactPrefix}.log`,
  )
  const simulatorScreenshotPath = join(
    artifactDir,
    `${surface.artifactPrefix}.png`,
  )
  const transientPaths = [
    readyPath,
    donePath,
    pythonReportPath,
    browserReportPath,
    finalReportPath,
    bundlePath,
    mqttBundlePath,
    cryptoWorkerBundlePath,
    mosquittoConfigPath,
    mosquittoLogPath,
    simulatorLogPath,
    simulatorScreenshotPath,
  ]
  await fs.mkdir(artifactDir, { recursive: true })
  await Promise.all(
    transientPaths.map((path) => fs.rm(path, { force: true })),
  )

  const simulator = selectSimulatorDevice(
    JSON.parse(
      capture('xcrun', [
        'simctl',
        'list',
        'devices',
        'available',
        '-j',
      ]),
    ),
    process.env.AURORA_IOS_SIMULATOR_UDID,
  )
  let bootedByHarness = false
  if (simulator.state !== 'Booted') {
    run('xcrun', ['simctl', 'boot', simulator.udid])
    bootedByHarness = true
  }
  run('xcrun', ['simctl', 'bootstatus', simulator.udid, '-b'])

  run(
    'pnpm',
    [
      'exec',
      'esbuild',
      browserEntry,
      '--bundle',
      '--format=esm',
      `--outfile=${bundlePath}`,
      '--platform=browser',
      '--target=safari17',
      '--external:mqtt',
      '--minify',
      '--log-level=silent',
    ],
    repoRoot,
  )
  run(
    'pnpm',
    [
      'exec',
      'esbuild',
      mqttEntry,
      '--bundle',
      '--format=esm',
      `--outfile=${mqttBundlePath}`,
      '--platform=browser',
      '--target=safari17',
      '--minify',
      '--log-level=silent',
    ],
    repoRoot,
  )
  run(
    'pnpm',
    [
      'exec',
      'esbuild',
      cryptoWorkerEntry,
      '--bundle',
      '--format=iife',
      `--outfile=${cryptoWorkerBundlePath}`,
      '--platform=browser',
      '--target=safari17',
      '--minify',
      '--log-level=silent',
    ],
    repoRoot,
  )

  await fs.writeFile(
    mosquittoConfigPath,
    [
      'per_listener_settings false',
      'allow_anonymous true',
      `listener ${brokerPort} 127.0.0.1`,
      'protocol websockets',
      '',
    ].join('\n'),
  )
  const mosquitto = spawn(
    'mosquitto',
    ['-c', mosquittoConfigPath, '-v'],
    {
      cwd: repoRoot,
      env: process.env,
      stdio: 'pipe',
    },
  )
  let mosquittoOutput = ''
  mosquitto.stdout.on('data', (chunk) => {
    mosquittoOutput += String(chunk)
  })
  mosquitto.stderr.on('data', (chunk) => {
    mosquittoOutput += String(chunk)
  })

  let server: http.Server | undefined
  let controlOrigin: string | undefined
  let pythonPeer: ChildProcessWithoutNullStreams | undefined
  let pythonOutput = ''
  let readyConfig: BrowserConfig | undefined
  let mobileResultSettled = false
  let resolveMobileResult: (result: MobileResult) => void = () =>
    undefined
  const mobileResultPromise = new Promise<MobileResult>(
    (resolvePromise) => {
      resolveMobileResult = (result) => {
        if (mobileResultSettled) return
        mobileResultSettled = true
        resolvePromise(result)
      }
    },
  )
  let targetBundleId = safariBundleId
  let launchedPid: number | undefined
  let wkWebViewHarness:
    | Awaited<ReturnType<typeof buildWkWebViewHarness>>
    | undefined
  let surfaceEvidence: Record<string, unknown> =
    surface.id === 'tauri-wkwebview'
      ? {
          kind: 'packaged-tauri-wkwebview',
          packagedTauriAppExpected: true,
          buildProfile: 'debug-ios-simulator',
          pythonSidecarConfigured: false,
          controlOrigin: '<loopback-test-control-origin>',
        }
      : {
          kind: 'mobile-browser',
          packagedTauriApp: false,
          browserBundleId: safariBundleId,
        }
  let closed = false
  const close = async () => {
    if (closed) return
    closed = true
    spawnSync(
      'xcrun',
      [
        'simctl',
        'terminate',
        simulator.udid,
        targetBundleId,
      ],
      { stdio: 'ignore' },
    )
    if (server?.listening) {
      await new Promise<void>((resolvePromise) =>
        server?.close(() => resolvePromise()),
      )
    }
    if (pythonPeer?.exitCode === null) {
      await terminateChild(pythonPeer, 5_000)
    }
    if (mosquitto.exitCode === null) {
      await terminateChild(mosquitto, 5_000)
    }
    await fs.writeFile(
      mosquittoLogPath,
      redactProcessOutput(mosquittoOutput),
    )
    if (wkWebViewHarness) {
      spawnSync(
        'xcrun',
        [
          'simctl',
          'uninstall',
          simulator.udid,
          wkWebViewHarness.bundleId,
        ],
        { stdio: 'ignore' },
      )
      await fs.rm(wkWebViewHarness.tempDir, {
        recursive: true,
        force: true,
      })
    }
    if (
      bootedByHarness &&
      process.env.AURORA_IOS_SIMULATOR_KEEP_BOOTED !== '1'
    ) {
      spawnSync(
        'xcrun',
        ['simctl', 'shutdown', simulator.udid],
        { stdio: 'ignore' },
      )
    }
    if (
      pythonPeer?.exitCode &&
      pythonPeer.exitCode !== 0 &&
      pythonOutput
    ) {
      console.error(
        redactInteropSeededText(
          redactProcessOutput(pythonOutput),
          seededSecrets,
        ),
      )
    }
  }

  try {
    await waitForPort(brokerPort, timeoutMs, mosquitto, () =>
      mosquittoOutput,
    )
    server = http.createServer(async (request, response) => {
      try {
        await handleHarnessRequest(
          request,
          response,
          bundlePath,
          mqttBundlePath,
          cryptoWorkerBundlePath,
          () => {
            if (!controlOrigin) {
              throw new Error(
                'iOS interop control origin is not ready',
              )
            }
            return controlOrigin
          },
          () => {
            if (!readyConfig) {
              throw new Error(
                `Python peer configuration is not ready for ${surface.browserName}`,
              )
            }
            return {
              ...readyConfig,
              roomSecret,
              runtimeLocation: {
                protocol: 'http:',
                hostname: '127.0.0.1',
              },
            }
          },
          resolveMobileResult,
        )
      } catch (error) {
        response.writeHead(500, {
          'content-type': 'application/json',
          'cache-control': 'no-store',
        })
        response.end(
          JSON.stringify({
            error:
              error instanceof Error ? error.message : String(error),
          }),
        )
      }
    })
    await new Promise<void>((resolvePromise) =>
      server?.listen(0, '127.0.0.1', resolvePromise),
    )
    const address = server.address()
    if (!address || typeof address === 'string') {
      throw new Error(
        'iOS mobile WebRTC harness did not expose a TCP port',
      )
    }
    const deviceHarnessUrl = `http://127.0.0.1:${address.port}/`
    controlOrigin = new URL(deviceHarnessUrl).origin
    if (surface.id === 'tauri-wkwebview') {
      wkWebViewHarness = await buildWkWebViewHarness({
        simulator,
        bundlePath,
        mqttBundlePath,
        cryptoWorkerBundlePath,
        controlOrigin,
        brokerPort,
      })
      targetBundleId = wkWebViewHarness.bundleId
      surfaceEvidence = {
        kind: 'packaged-tauri-wkwebview',
        packagedTauriApp: true,
        bundleId: wkWebViewHarness.bundleId,
        buildProfile: 'debug-ios-simulator',
        frontendEmbedded: true,
        artifactProof: wkWebViewHarness.artifactProof,
        controlOrigin: '<loopback-test-control-origin>',
      }
    }

    pythonPeer = spawn(
      'uv',
      [
        'run',
        'python',
        gatewayScript,
        '--lane',
        'direct',
        '--ready',
        readyPath,
        '--done',
        donePath,
        '--report',
        pythonReportPath,
        '--broker',
        `ws://127.0.0.1:${brokerPort}/mqtt`,
        '--room',
        room,
        '--timeout',
        String(timeoutMs / 1000),
      ],
      {
        cwd: repoRoot,
        env: {
          ...process.env,
          WEBRTC_INTEROP_ROOM_SECRET: roomSecret,
          WEBRTC_INTEROP_TOKEN: token,
        },
        stdio: 'pipe',
      },
    )
    pythonPeer.stdout.on('data', (chunk) => {
      pythonOutput += String(chunk)
    })
    pythonPeer.stderr.on('data', (chunk) => {
      pythonOutput += String(chunk)
    })

    return {
      timeoutMs,
      artifactDir,
      simulator,
      surfaceEvidence,
      readyPath,
      donePath,
      pythonReportPath,
      browserReportPath,
      finalReportPath,
      pythonPeer,
      getPythonOutput: () =>
        redactInteropSeededText(
          redactProcessOutput(pythonOutput),
          seededSecrets,
        ),
      assertNoSeededSecrets(value: unknown): void {
        assertNoInteropSeededSecrets(value, seededSecrets)
      },
      redactArtifactValue<T>(value: T): T {
        return redactInteropArtifactValue(value, seededSecrets)
      },
      setReadyConfig(value: BrowserConfig) {
        readyConfig = value
      },
      async launchBrowser(): Promise<void> {
        spawnSync(
          'xcrun',
          [
            'simctl',
            'terminate',
            simulator.udid,
            targetBundleId,
          ],
          { stdio: 'ignore' },
        )
        if (surface.id === 'mobile-safari') {
          run('xcrun', [
            'simctl',
            'openurl',
            simulator.udid,
            deviceHarnessUrl,
          ])
          return
        }
        const launchOutput = capture('xcrun', [
          'simctl',
          'launch',
          simulator.udid,
          targetBundleId,
        ])
        launchedPid = parseSimulatorLaunchPid(
          launchOutput,
          targetBundleId,
        )
      },
      async waitForMobileResult(waitMs: number): Promise<MobileResult> {
        const deadline = Date.now() + waitMs
        while (Date.now() < deadline) {
          const outcome = await Promise.race([
            mobileResultPromise.then((value) => ({
              type: 'result' as const,
              value,
            })),
            sleep(2_000).then(() => ({
              type: 'poll' as const,
            })),
          ])
          if (outcome.type === 'result') return outcome.value
          if (
            pythonPeer?.exitCode !== null &&
            pythonPeer?.exitCode !== undefined
          ) {
            throw new Error(
              `Python WebRTC peer exited before ${surface.browserName} returned a result with ${pythonPeer.exitCode}: ${redactProcessOutput(
                redactInteropSeededText(pythonOutput, seededSecrets),
              )}`,
            )
          }
        }
        throw new Error(
          `Timed out waiting for ${surface.browserName} interop result after ${waitMs}ms`,
        )
      },
      async captureSimulatorEvidence(): Promise<void> {
        const screenshot = spawnSync(
          'xcrun',
          [
            'simctl',
            'io',
            simulator.udid,
            'screenshot',
            simulatorScreenshotPath,
          ],
          { encoding: 'utf8' },
        )
        if (screenshot.status !== 0) {
          throw new Error(
            `Could not capture iOS simulator screenshot: ${screenshot.stderr}`,
          )
        }
        if (
          !existsSync(simulatorScreenshotPath) ||
          statSync(simulatorScreenshotPath).size === 0
        ) {
          throw new Error(
            `iOS simulator did not create ${surface.browserName} screenshot evidence`,
          )
        }
        const log = capture(
          'xcrun',
          [
            'simctl',
            'spawn',
            simulator.udid,
            'log',
            'show',
            '--style',
            'compact',
            '--last',
            '5m',
            '--predicate',
            launchedPid
              ? `processIdentifier == ${launchedPid} OR process == "com.apple.WebKit.WebContent"`
              : 'process == "MobileSafari" OR process == "com.apple.WebKit.WebContent"',
          ],
          { allowFailure: true },
        )
        await fs.writeFile(
          simulatorLogPath,
          redactProcessOutput(log),
        )
        if (
          /\b(?:EXC_CRASH|EXC_BAD_ACCESS)\b|Terminating app due to uncaught exception|dyld: Library not loaded|\bfatal error:/iu.test(
            log,
          )
        ) {
          throw new Error(
            `iOS simulator log contains ${surface.browserName}/WebContent crash evidence`,
          )
        }
      },
      close,
    }
  } catch (error) {
    const redactedError = redactInteropArtifactValue(
      error instanceof Error ? error.message : String(error),
      seededSecrets,
    )
    const failureReport = redactInteropArtifactValue(
      {
        lane: 'direct',
        browserName: surface.browserName,
        status: 'failed',
        phase: 'setup',
        error: redactedError,
        simulator,
        surface: surfaceEvidence,
        secretsRedacted: true,
      },
      seededSecrets,
    )
    assertNoInteropSeededSecrets(failureReport, seededSecrets)
    try {
      await writeJson(browserReportPath, failureReport)
      await writeJson(donePath, {
        ok: false,
        at: new Date().toISOString(),
      })
    } finally {
      await close()
    }
    throw new Error(String(redactedError))
  }
}

async function buildWkWebViewHarness({
  simulator,
  bundlePath,
  mqttBundlePath,
  cryptoWorkerBundlePath,
  controlOrigin,
  brokerPort,
}: {
  simulator: SimulatorDevice
  bundlePath: string
  mqttBundlePath: string
  cryptoWorkerBundlePath: string
  controlOrigin: string
  brokerPort: number
}): Promise<{
  tempDir: string
  bundleId: string
  artifactProof: WkWebViewArtifactProof
}> {
  const tempDir = await fs.mkdtemp(
    join(tmpdir(), 'aurora-ios-wkwebview-interop-'),
  )
  const distDir = join(tempDir, 'dist')
  const configPath = join(tempDir, 'tauri.wkwebview-interop.conf.json')
  const bundleId = 'dev.aurora.desktop'
  try {
    await fs.mkdir(distDir, { recursive: true })
    await Promise.all([
      fs.copyFile(
        bundlePath,
        join(distDir, 'ios-mobile-browser-bundle.js'),
      ),
      fs.copyFile(
        mqttBundlePath,
        join(distDir, 'mqtt-bundle.mjs'),
      ),
      fs.copyFile(
        cryptoWorkerBundlePath,
        join(distDir, 'crypto-worker-bundle.js'),
      ),
      fs.writeFile(
        join(distDir, 'index.html'),
        wkWebViewHarnessHtml(),
      ),
      fs.writeFile(
        join(distDir, 'ios-wkwebview-runner.js'),
        wkWebViewHarnessRunner(controlOrigin),
      ),
    ])
    await fs.writeFile(
      configPath,
      `${JSON.stringify(
        {
          build: {
            beforeBuildCommand: null,
            // The additional config is merged from src-tauri, so a relative
            // path would resolve there instead of beside this temp config.
            frontendDist: distDir,
          },
          app: {
            windows: [
              {
                label: 'main',
                title: 'Aurora WebRTC Interop',
                width: 430,
                height: 932,
              },
            ],
            security: {
              capabilities: [
                'aurora-ios-thin',
                'aurora-mobile-mesh',
              ],
              csp: [
                "default-src 'self'",
                `connect-src 'self' ${controlOrigin} ws://127.0.0.1:${brokerPort}`,
                "img-src 'self' data: blob:",
                "media-src 'self' blob: mediastream:",
                "style-src 'self' 'unsafe-inline'",
                "script-src 'self'",
                "worker-src 'self' blob:",
              ].join('; '),
            },
          },
          bundle: {
            active: true,
            externalBin: [],
            resources: {},
          },
        },
        null,
        2,
      )}\n`,
    )

    run(
      'pnpm',
      [
        'tauri',
        'ios',
        'build',
        '--debug',
        '--target',
        'aarch64-sim',
        '--config',
        configPath,
      ],
      appRoot,
    )
    const appPath = findBuiltSimulatorApp(bundleId)
    const artifactProof = inspectWkWebViewArtifact(appPath)
    run('xcrun', [
      'simctl',
      'install',
      simulator.udid,
      appPath,
    ])
    return {
      tempDir,
      bundleId,
      artifactProof,
    }
  } catch (error) {
    await fs.rm(tempDir, { recursive: true, force: true })
    throw error
  }
}

function inspectWkWebViewArtifact(
  appPath: string,
): WkWebViewArtifactProof {
  const result = spawnSync('find', [appPath, '-print'], {
    encoding: 'utf8',
  })
  if (result.status !== 0) {
    throw new Error(
      'Could not inspect the packaged iOS WKWebView application',
    )
  }
  const entries = String(result.stdout)
    .split('\n')
    .map((value) => value.trim())
    .filter(Boolean)
    .map((value) => relative(appPath, value))
    .filter(Boolean)
  const forbiddenPatterns = [
    /aurora-sidecar/iu,
    /prepare-sidecar/iu,
    /config_defaults\.json/iu,
    /(^|[/\\])python(?:\d+(?:\.\d+)?)?(?:\.exe)?$/iu,
    /libpython[^/\\]*\.(?:so|dylib|dll)$/iu,
    /pyvenv\.cfg/iu,
    /site-packages/iu,
    /__pycache__/iu,
    /(^|[/\\])main\.py$/iu,
  ]
  const forbiddenMatches = entries.filter((entry) =>
    forbiddenPatterns.some((pattern) => pattern.test(entry)),
  )
  if (forbiddenMatches.length > 0) {
    throw new Error(
      `Packaged iOS WKWebView application contains forbidden Python/sidecar paths: ${forbiddenMatches
        .slice(0, 10)
        .join(', ')}`,
    )
  }
  return {
    checkedEntries: entries.length,
    forbiddenMatchCount: 0,
    pythonSidecarPackaged: false,
  }
}

function findBuiltSimulatorApp(expectedBundleId: string): string {
  const buildRoot = join(appRoot, 'src-tauri', 'gen', 'apple')
  if (!existsSync(buildRoot)) {
    throw new Error(
      'Generated iOS project is missing; run tauri ios init before WKWebView interoperability',
    )
  }
  const result = spawnSync(
    'find',
    [buildRoot, '-type', 'd', '-name', '*.app', '-prune'],
    { encoding: 'utf8' },
  )
  if (result.status !== 0) {
    throw new Error(
      'Could not enumerate built iOS simulator applications',
    )
  }
  const candidates = String(result.stdout)
    .split('\n')
    .map((value) => value.trim())
    .filter(Boolean)
  candidates.sort(
    (left, right) =>
      statSync(right).mtimeMs - statSync(left).mtimeMs,
  )
  for (const candidate of candidates) {
    const candidateBundleId = capture(
      'plutil',
      [
        '-extract',
        'CFBundleIdentifier',
        'raw',
        '-o',
        '-',
        join(candidate, 'Info.plist'),
      ],
      { allowFailure: true },
    ).trim()
    if (candidateBundleId === expectedBundleId) return candidate
  }
  throw new Error(
    `No built iOS simulator app has bundle id ${expectedBundleId}`,
  )
}

function parseSimulatorLaunchPid(
  output: string,
  expectedBundleId: string,
): number {
  const match = new RegExp(
    `${escapeRegex(expectedBundleId)}:\\s*(\\d+)`,
    'u',
  ).exec(output)
  const pid = Number(match?.[1])
  if (!Number.isInteger(pid) || pid <= 0) {
    throw new Error(
      `simctl launch did not return a process id for ${expectedBundleId}`,
    )
  }
  return pid
}

function wkWebViewHarnessHtml(): string {
  return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>Aurora Tauri WKWebView WebRTC Interop</title>
    <style>
      body { font-family: -apple-system, sans-serif; padding: 2rem; }
      [data-status="passed"] { color: #087a32; }
      [data-status="failed"] { color: #a00; }
    </style>
  </head>
  <body>
    <h1>Aurora packaged WKWebView interoperability</h1>
    <p id="status" data-status="running">Connecting to the Python peer…</p>
    <script type="module" src="/ios-mobile-browser-bundle.js"></script>
    <script type="module" src="/ios-wkwebview-runner.js"></script>
  </body>
</html>`
}

function wkWebViewHarnessRunner(controlOrigin: string): string {
  return `const controlOrigin = ${JSON.stringify(controlOrigin)};
const status = document.getElementById('status');
const consoleErrors = [];
window.addEventListener('error', (event) => {
  consoleErrors.push(String(event.error?.message ?? event.message));
});
window.addEventListener('unhandledrejection', (event) => {
  consoleErrors.push(String(event.reason?.message ?? event.reason));
});
const publish = async (value) => {
  await fetch(controlOrigin + '/interop-result', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ...value, consoleErrors })
  });
};
Promise.resolve().then(async () => {
  const configResponse = await fetch(controlOrigin + '/interop-config', {
    cache: 'no-store'
  });
  if (!configResponse.ok) {
    throw new Error('Could not load the interop configuration');
  }
  const config = await configResponse.json();
  const moduleDeadline = Date.now() + 120000;
  while (
    typeof globalThis.runAuroraWebRtcInterop !== 'function' &&
    Date.now() < moduleDeadline
  ) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  if (typeof globalThis.runAuroraWebRtcInterop !== 'function') {
    throw new Error('runAuroraWebRtcInterop was not installed');
  }
  const result = await globalThis.runAuroraWebRtcInterop(config);
  status.dataset.status = 'passed';
  status.textContent = 'Paired with the Python peer over WebRTC.';
  await publish({ ok: true, result });
}).catch(async (error) => {
  status.dataset.status = 'failed';
  status.textContent = 'WebRTC interoperability failed.';
  await publish({
    ok: false,
    error: {
      name: error?.name ?? 'Error',
      message: error?.message ?? String(error),
      stack: error?.stack ?? ''
    }
  }).catch(() => undefined);
});\n`
}

async function handleHarnessRequest(
  request: IncomingMessage,
  response: ServerResponse,
  bundlePath: string,
  mqttBundlePath: string,
  cryptoWorkerBundlePath: string,
  getControlOrigin: () => string,
  getConfig: () => Record<string, unknown>,
  publishResult: (result: MobileResult) => void,
): Promise<void> {
  const requestUrl = new URL(
    request.url ?? '/',
    `http://${request.headers.host ?? '127.0.0.1'}`,
  )
  const requestOrigin = request.headers.origin
  const controlOrigin = getControlOrigin()
  const allowedOrigins = new Set([
    controlOrigin,
    'tauri://localhost',
    'http://tauri.localhost',
    'https://tauri.localhost',
  ])
  if (
    requestUrl.origin !== controlOrigin ||
    (requestOrigin !== undefined &&
      !allowedOrigins.has(requestOrigin))
  ) {
    response.writeHead(403, { 'cache-control': 'no-store' })
    response.end()
    return
  }
  const corsHeaders =
    requestOrigin === undefined
      ? {}
      : {
          'access-control-allow-origin': requestOrigin,
          'access-control-allow-methods': 'GET, POST, OPTIONS',
          'access-control-allow-headers': 'content-type',
          vary: 'origin',
        }
  if (request.method === 'OPTIONS') {
    response.writeHead(204, {
      ...corsHeaders,
      'cache-control': 'no-store',
    })
    response.end()
    return
  }
  if (requestUrl.pathname === '/mqtt-bundle.mjs') {
    response.writeHead(200, {
      'content-type': 'application/javascript',
      'cache-control': 'no-store',
    })
    response.end(await fs.readFile(mqttBundlePath))
    return
  }
  if (requestUrl.pathname === '/ios-mobile-browser-bundle.js') {
    response.writeHead(200, {
      'content-type': 'application/javascript',
      'cache-control': 'no-store',
    })
    response.end(await fs.readFile(bundlePath))
    return
  }
  if (requestUrl.pathname === '/crypto-worker-bundle.js') {
    response.writeHead(200, {
      'content-type': 'application/javascript',
      'cache-control': 'no-store',
    })
    response.end(await fs.readFile(cryptoWorkerBundlePath))
    return
  }
  if (requestUrl.pathname === '/interop-config') {
    response.writeHead(200, {
      ...corsHeaders,
      'content-type': 'application/json',
      'cache-control': 'no-store',
    })
    response.end(JSON.stringify(getConfig()))
    return
  }
  if (
    requestUrl.pathname === '/interop-result' &&
    request.method === 'POST'
  ) {
    const value = JSON.parse(
      await readRequestBody(request, 2 * 1024 * 1024),
    ) as MobileResult
    publishResult(value)
    response.writeHead(204, {
      ...corsHeaders,
      'cache-control': 'no-store',
    })
    response.end()
    return
  }
  if (requestUrl.pathname === '/favicon.ico') {
    response.writeHead(204)
    response.end()
    return
  }
  response.writeHead(200, {
    'content-type': 'text/html',
    'cache-control': 'no-store',
  })
  response.end(mobileHarnessHtml())
}

function mobileHarnessHtml(): string {
  return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>Aurora iOS WebRTC Interop</title>
    <style>
      body { font-family: -apple-system, sans-serif; padding: 2rem; }
      [data-status="passed"] { color: #087a32; }
      [data-status="failed"] { color: #a00; }
    </style>
  </head>
  <body>
    <h1>Aurora mobile WebRTC interoperability</h1>
    <p id="status" data-status="running">Connecting to the Python peer…</p>
    <script type="module" src="/ios-mobile-browser-bundle.js"></script>
    <script>
      (() => {
        const status = document.getElementById('status');
        const consoleErrors = [];
        window.addEventListener('error', (event) => {
          consoleErrors.push(String(event.error?.message ?? event.message));
        });
        window.addEventListener('unhandledrejection', (event) => {
          consoleErrors.push(String(event.reason?.message ?? event.reason));
        });
        const publish = async (value) => {
          await fetch('/interop-result', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ ...value, consoleErrors })
          });
        };
        Promise.resolve().then(async () => {
          const configResponse = await fetch('/interop-config', {
            cache: 'no-store'
          });
          if (!configResponse.ok) {
            throw new Error('Could not load the interop configuration');
          }
          const config = await configResponse.json();
          const moduleDeadline = Date.now() + 120000;
          while (
            typeof globalThis.runAuroraWebRtcInterop !== 'function' &&
            Date.now() < moduleDeadline
          ) {
            await new Promise((resolve) => setTimeout(resolve, 100));
          }
          if (typeof globalThis.runAuroraWebRtcInterop !== 'function') {
            throw new Error('runAuroraWebRtcInterop was not installed');
          }
          const result = await globalThis.runAuroraWebRtcInterop(config);
          status.dataset.status = 'passed';
          status.textContent = 'Paired with the Python peer over WebRTC.';
          await publish({ ok: true, result });
        }).catch(async (error) => {
          status.dataset.status = 'failed';
          status.textContent = 'WebRTC interoperability failed.';
          await publish({
            ok: false,
            error: {
              name: error?.name ?? 'Error',
              message: error?.message ?? String(error),
              stack: error?.stack ?? ''
            }
          }).catch(() => undefined);
        });
      })();
    </script>
  </body>
</html>`
}

function selectSimulatorDevice(
  listing: Record<string, unknown>,
  requestedUdid?: string,
): SimulatorDevice {
  const deviceGroups = listing.devices
  if (
    deviceGroups === null ||
    typeof deviceGroups !== 'object' ||
    Array.isArray(deviceGroups)
  ) {
    throw new Error('simctl returned no available simulator devices')
  }
  const candidates = Object.entries(deviceGroups).flatMap(
    ([runtime, devices]) =>
      (Array.isArray(devices) ? devices : [])
        .filter(
          (device) =>
            device &&
            typeof device === 'object' &&
            (device as { isAvailable?: boolean }).isAvailable !==
              false &&
            (device as { availabilityError?: unknown })
              .availabilityError == null,
        )
        .map((device) => ({
          ...(device as {
            name: string
            udid: string
            state: string
          }),
          runtime,
        })),
  )
  if (requestedUdid) {
    const requested = candidates.find(
      (device) => device.udid === requestedUdid,
    )
    if (!requested) {
      throw new Error(
        `Requested iOS simulator ${requestedUdid} is not available`,
      )
    }
    return requested
  }
  const iphones = candidates.filter((device) =>
    String(device.name).startsWith('iPhone'),
  )
  const pool = iphones.length > 0 ? iphones : candidates
  pool.sort((left, right) => {
    const runtimeDelta = compareRuntime(
      right.runtime,
      left.runtime,
    )
    if (runtimeDelta !== 0) return runtimeDelta
    const bootedDelta =
      Number(right.state === 'Booted') -
      Number(left.state === 'Booted')
    if (bootedDelta !== 0) return bootedDelta
    return String(right.name).localeCompare(String(left.name))
  })
  const selected = pool[0]
  if (!selected?.udid) {
    throw new Error('No available iOS simulator was found')
  }
  return selected
}

function compareRuntime(left: string, right: string): number {
  const leftParts = runtimeVersion(left)
  const rightParts = runtimeVersion(right)
  for (
    let index = 0;
    index < Math.max(leftParts.length, rightParts.length);
    index += 1
  ) {
    const delta =
      (leftParts[index] ?? 0) - (rightParts[index] ?? 0)
    if (delta !== 0) return delta
  }
  return 0
}

function runtimeVersion(runtime: string): number[] {
  return (
    runtime
      .match(/iOS-(\d+(?:-\d+)*)$/u)?.[1]
      ?.split('-')
      .map(Number) ?? [0]
  )
}

async function readRequestBody(
  request: IncomingMessage,
  maxBytes: number,
): Promise<string> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of request) {
    const buffer = Buffer.from(chunk)
    size += buffer.length
    if (size > maxBytes) {
      throw new Error(
        'iOS mobile interop result exceeded the size limit',
      )
    }
    chunks.push(buffer)
  }
  return Buffer.concat(chunks).toString('utf8')
}

async function waitForJson<T>(
  path: string,
  timeoutMs: number,
  label: string,
  child?: ChildProcessWithoutNullStreams,
  childOutput?: () => string,
): Promise<T> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      return JSON.parse(await fs.readFile(path, 'utf8')) as T
    } catch {
      if (
        child?.exitCode !== null &&
        child?.exitCode !== undefined
      ) {
        const output = childOutput?.()
        throw new Error(
          `Python WebRTC peer exited before ${label} with ${child.exitCode}${
            output
              ? `: ${redactProcessOutput(output)}`
              : ''
          }`,
        )
      }
      await sleep(100)
    }
  }
  throw new Error(`Timed out waiting for ${label}`)
}

async function waitForPort(
  port: number,
  timeoutMs: number,
  child?: ChildProcessWithoutNullStreams,
  childOutput?: () => string,
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (
      child?.exitCode !== null &&
      child?.exitCode !== undefined
    ) {
      throw new Error(
        `Service exited before 127.0.0.1:${port} opened with ${child.exitCode}: ${redactProcessOutput(
          childOutput?.() ?? '',
        )}`,
      )
    }
    const connected = await new Promise<boolean>(
      (resolvePromise) => {
        const socket = net.connect({
          host: '127.0.0.1',
          port,
        })
        socket.once('connect', () => {
          socket.destroy()
          resolvePromise(true)
        })
        socket.once('error', () => resolvePromise(false))
        socket.setTimeout(500, () => {
          socket.destroy()
          resolvePromise(false)
        })
      },
    )
    if (connected) return
    await sleep(100)
  }
  throw new Error(`Timed out waiting for 127.0.0.1:${port}`)
}

async function allocateTcpPort(): Promise<number> {
  return await new Promise<number>((resolvePromise, rejectPromise) => {
    const server = net.createServer()
    server.once('error', rejectPromise)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (!address || typeof address === 'string') {
        server.close()
        rejectPromise(
          new Error('Could not allocate a local signaling port'),
        )
        return
      }
      const { port } = address
      server.close((error) => {
        if (error) rejectPromise(error)
        else resolvePromise(port)
      })
    })
  })
}

async function waitForChild(
  child: ChildProcessWithoutNullStreams,
  timeoutMs: number,
): Promise<void> {
  if (child.exitCode !== null) {
    if (child.exitCode !== 0) {
      throw new Error(`Child process exited with ${child.exitCode}`)
    }
    return
  }
  await Promise.race([
    new Promise<void>((resolvePromise, rejectPromise) => {
      child.once('exit', (code) => {
        if (code === 0) resolvePromise()
        else {
          rejectPromise(
            new Error(`Child process exited with ${code}`),
          )
        }
      })
    }),
    sleep(timeoutMs).then(() => {
      throw new Error(
        `Timed out waiting for child process after ${timeoutMs}ms`,
      )
    }),
  ])
}

async function terminateChild(
  child: ChildProcessWithoutNullStreams,
  timeoutMs: number,
): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return
  child.kill('SIGTERM')
  try {
    await waitForExit(child, timeoutMs)
  } catch {
    child.kill('SIGKILL')
    await waitForExit(child, timeoutMs).catch(() => undefined)
  }
}

async function waitForExit(
  child: ChildProcessWithoutNullStreams,
  timeoutMs: number,
): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return
  await Promise.race([
    new Promise<void>((resolvePromise) => {
      child.once('exit', () => resolvePromise())
    }),
    sleep(timeoutMs).then(() => {
      throw new Error(
        `Timed out waiting for child process exit after ${timeoutMs}ms`,
      )
    }),
  ])
}

function assertCommandAvailable(
  command: string,
  args: string[],
): void {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
  })
  if (result.error || result.status !== 0) {
    throw new Error(
      `${command} is required for iOS mobile WebRTC interop`,
    )
  }
}

function capture(
  command: string,
  args: string[],
  options: { allowFailure?: boolean } = {},
): string {
  const result = spawnSync(command, args, {
    cwd: repoRoot,
    env: process.env,
    encoding: 'utf8',
  })
  if (
    result.status !== 0 &&
    options.allowFailure !== true
  ) {
    throw new Error(
      `${command} ${args.join(' ')} failed with ${result.status}: ${redactProcessOutput(
        `${result.stdout ?? ''}\n${result.stderr ?? ''}`,
      )}`,
    )
  }
  return `${result.stdout ?? ''}${result.stderr ?? ''}`
}

function redactProcessOutput(value: string): string {
  return value
    .replace(
      /(WEBRTC_INTEROP_(?:ROOM_SECRET|TOKEN)=)[^\s]+/gu,
      '$1[REDACTED]',
    )
    .replace(
      /([?&](?:token|secret)=)[^&\s]+/giu,
      '$1[REDACTED]',
    )
    .slice(-20_000)
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
}

function run(
  command: string,
  args: string[],
  cwd: string = repoRoot,
): void {
  const result = spawnSync(command, args, {
    cwd,
    env: process.env,
    encoding: 'utf8',
    stdio: 'pipe',
  })
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(' ')} failed with ${result.status}: ${redactProcessOutput(
        `${result.stdout ?? ''}\n${result.stderr ?? ''}`,
      )}`,
    )
  }
}

async function writeJson(
  path: string,
  value: Record<string, unknown>,
): Promise<void> {
  await fs.mkdir(dirname(path), { recursive: true })
  await fs.writeFile(
    path,
    `${JSON.stringify(value, null, 2)}\n`,
  )
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolvePromise) =>
    setTimeout(resolvePromise, ms),
  )
}
