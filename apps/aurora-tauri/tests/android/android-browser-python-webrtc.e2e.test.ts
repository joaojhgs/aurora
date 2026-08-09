// @vitest-environment node

import {
  spawn,
  spawnSync,
  type ChildProcessWithoutNullStreams,
} from 'node:child_process'
import crypto from 'node:crypto'
import dgram from 'node:dgram'
import { existsSync } from 'node:fs'
import fs from 'node:fs/promises'
import http, {
  type IncomingMessage,
  type ServerResponse,
} from 'node:http'
import net from 'node:net'
import os from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'

import {
  assertNoInteropSeededSecrets,
  assertInteropBrowserResult,
  redactInteropArtifactValue,
  redactInteropSeededText,
  type InteropBrowserResult,
} from '../../../../tests/e2e/webrtc_interop/assertions.js'
import {
  androidWebRtcBrokerUrl,
  androidWebRtcComposeArgs,
  androidWebRtcServicesComposeYaml,
  androidWebRtcStunUrl,
  androidWebRtcTurnUrl,
  createAndroidHarnessRequestLog,
  resolveAndroidWebRtcServicePorts,
  type AndroidHarnessRequestLogEntry,
} from './android-webrtc-harness-utils.js'

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

type AndroidBrowserDiagnostics = {
  harnessRequests: AndroidHarnessRequestLogEntry[]
  currentActivity: string
  windowHierarchy: string
  logcatTail: string
}

const repoRoot = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../../..',
)
const appRoot = resolve(repoRoot, 'apps/aurora-tauri')
process.env.COMPOSE_PROJECT_NAME ||= 'aurora-android-mobile-webrtc-e2e'
const composeProjectName = process.env.COMPOSE_PROJECT_NAME
const gatewayScript = resolve(repoRoot, 'scripts/webrtc_interop_gateway.py')
const scannerScript = resolve(repoRoot, 'scripts/webrtc_interop_scan.py')
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
const mqttImportMapJson = '{"imports":{"mqtt":"/mqtt-bundle.mjs"}}'
const configuredBrowserPackage =
  process.env.AURORA_ANDROID_BROWSER_PACKAGE?.trim() || null
let browserPackage = configuredBrowserPackage ?? 'com.android.chrome'
let browserComponent: string | null = null
const artifactDir =
  process.env.AURORA_ANDROID_MOBILE_WEBRTC_ARTIFACT_DIR ??
  resolve(appRoot, 'reports/webrtc-interop/android-mobile-browser')
const interopTimeoutMs = Number(
  process.env.AURORA_ANDROID_MOBILE_WEBRTC_TIMEOUT_MS ?? 180_000,
)
const interopLane = (() => {
  const lane =
    process.env.AURORA_ANDROID_MOBILE_WEBRTC_LANE ?? 'direct'
  if (lane !== 'direct' && lane !== 'stun' && lane !== 'turn') {
    throw new Error(
      `AURORA_ANDROID_MOBILE_WEBRTC_LANE must be direct, stun, or turn; received ${lane}`,
    )
  }
  return lane
})()
const testTimeoutMs = Math.max(480_000, interopTimeoutMs + 120_000)
const adb = resolveAdbCommand()

let cleanup: (() => Promise<void>) | undefined

afterEach(async () => {
  await cleanup?.()
  cleanup = undefined
})

describe('Android mobile-browser WebRTC interoperability', () => {
  it(
    'pairs an Android browser peer with Python without CDP or HTTP transport fallback',
    async () => {
      const resources = await createInteropResources()
      cleanup = resources.close

      const ready = await waitForJson<BrowserConfig>(
        resources.readyPath,
        resources.timeoutMs,
        'Python peer readiness',
        resources.pythonPeer,
        resources.getPythonOutput,
      )
      resources.setReadyConfig(ready)
      await launchAndroidBrowser(resources.deviceHarnessUrl)
      await resources.waitForHarnessLoad(
        Math.min(90_000, resources.timeoutMs),
      )

      const started = Date.now()
      let mobileResult: MobileResult | undefined
      try {
        mobileResult = await resources.waitForMobileResult(
          resources.timeoutMs,
        )
        if (!mobileResult.ok || !mobileResult.result) {
          throw new Error(
            mobileResult.error?.stack ||
              mobileResult.error?.message ||
              'Android mobile browser reported an unknown interop failure',
          )
        }

        const browserResult = mobileResult.result
        resources.assertNoSeededSecrets(mobileResult)
        assertInteropBrowserResult(browserResult, {
          lane: interopLane,
          expectedStablePeerId: ready.expectedStablePeerId,
          expectedNegotiationRole: ready.expectedNegotiationRole,
        })
        expect(mobileResult.consoleErrors ?? []).toEqual([])

        await writeJson(resources.browserReportPath, {
          lane: interopLane,
          browserName: 'android-browser',
          browserPackage,
          status: 'passed',
          durationMs: Date.now() - started,
          command:
            'pnpm --filter @aurora/tauri-ui android:webrtc:mobile-browser',
          browserResult,
          noHttpFetchTransportUsed: true,
          observation:
            'auto-running loopback harness; application fetches are instrumented inside the WebRTC runtime and the result callback runs only after runtime close',
          consoleErrors: mobileResult.consoleErrors ?? [],
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
            artifactDir,
            '--python-report',
            resources.pythonReportPath,
            '--browser-report',
            resources.browserReportPath,
            '--out',
            resources.finalReportPath,
            '--lane',
            interopLane,
          ],
          repoRoot,
        )
        const aggregate = await waitForJson<Record<string, unknown>>(
          resources.finalReportPath,
          10_000,
          'aggregate Android mobile WebRTC report',
        )
        resources.assertNoSeededSecrets(aggregate)
        expect(aggregate).toMatchObject({
          status: 'passed',
          lane: interopLane,
          pathCategoryAccepted: true,
          secretsRedacted: true,
        })

        const holdMs = Number(
          process.env.AURORA_ANDROID_MOBILE_WEBRTC_HOLD_MS ?? 0,
        )
        if (holdMs > 0) await sleep(holdMs)
      } catch (error) {
        const redactedError = resources.redactArtifactValue(
          error instanceof Error ? error.message : String(error),
        )
        const failureReport = resources.redactArtifactValue({
          lane: interopLane,
          browserName: 'android-browser',
          browserPackage,
          status: 'failed',
          durationMs: Date.now() - started,
          error: redactedError,
          mobileResult,
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
    },
    testTimeoutMs,
  )
})

async function createInteropResources() {
  const timeoutMs = interopTimeoutMs
  const servicePorts = resolveAndroidWebRtcServicePorts()
  const roomSecret = crypto.randomBytes(32).toString('base64url')
  const token = `android-mobile.${crypto
    .randomBytes(24)
    .toString('base64url')}`
  const seededSecrets = [roomSecret, token]
  const room = `android-mobile-${process.pid}-${Date.now().toString(36)}`
  const hostIpv4 =
    interopLane === 'direct' ? undefined : await resolveHostIpv4()
  const stunServer =
    interopLane === 'stun' && hostIpv4 !== undefined
      ? androidWebRtcStunUrl(hostIpv4, servicePorts)
      : undefined
  const turnServer =
    interopLane === 'turn' && hostIpv4 !== undefined
      ? (process.env.AURORA_ANDROID_WEBRTC_TURN_URL ??
        androidWebRtcTurnUrl(hostIpv4, servicePorts))
      : undefined
  const readyPath = join(artifactDir, 'gateway-ready.json')
  const donePath = join(artifactDir, 'android-mobile-done.json')
  const pythonReportPath = join(artifactDir, 'python-gateway-report.json')
  const browserReportPath = join(
    artifactDir,
    'android-mobile-browser-report.json',
  )
  const finalReportPath = join(artifactDir, 'report.json')
  const bundlePath = join(artifactDir, 'android-mobile-browser-bundle.js')
  const mqttBundlePath = join(artifactDir, 'mqtt-bundle.mjs')
  const legacyMqttBundlePath = join(artifactDir, 'mqtt-bundle.js')
  const cryptoWorkerBundlePath = join(
    artifactDir,
    'crypto-worker-bundle.js',
  )
  const serviceComposePath = join(
    artifactDir,
    'docker-compose.webrtc-interop.generated.yml',
  )
  const transientPaths = [
    readyPath,
    donePath,
    pythonReportPath,
    browserReportPath,
    finalReportPath,
    bundlePath,
    mqttBundlePath,
    legacyMqttBundlePath,
    cryptoWorkerBundlePath,
    serviceComposePath,
  ]
  await fs.mkdir(artifactDir, { recursive: true })
  await Promise.all(
    transientPaths.map((path) => fs.rm(path, { force: true })),
  )

  let servicesStarted = false
  let server: http.Server | undefined
  let pythonPeer: ChildProcessWithoutNullStreams | undefined
  let pythonOutput = ''
  let hostPort: number | undefined
  let readyConfig: BrowserConfig | undefined
  let mobileResultSettled = false
  const harnessRequests = createAndroidHarnessRequestLog()
  let resolveMobileResult: (result: MobileResult) => void = () => undefined
  const mobileResultPromise = new Promise<MobileResult>((resolvePromise) => {
    resolveMobileResult = (result) => {
      if (mobileResultSettled) return
      mobileResultSettled = true
      resolvePromise(result)
    }
  })
  const reversedPorts = new Set<number>()
  let closed = false
  const close = async () => {
    if (closed) return
    closed = true
    spawnSync(adb, ['shell', 'am', 'force-stop', browserPackage], {
      stdio: 'ignore',
    })
    for (const port of reversedPorts) {
      spawnSync(adb, ['reverse', '--remove', `tcp:${port}`], {
        stdio: 'ignore',
      })
    }
    if (server?.listening) {
      await new Promise<void>((resolvePromise) =>
        server?.close(() => resolvePromise()),
      )
    }
    if (pythonPeer?.exitCode === null) {
      pythonPeer.kill('SIGTERM')
      try {
        await waitForChild(pythonPeer, 5_000)
      } catch {
        pythonPeer.kill('SIGKILL')
      }
    }
    if (servicesStarted) {
      spawnSync(
        'docker',
        androidWebRtcComposeArgs(
          serviceComposePath,
          'down',
          composeProjectName,
        ),
        {
          cwd: repoRoot,
          stdio: 'inherit',
        },
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
    assertAndroidDevicePreflight('Android mobile-browser WebRTC interop')
    resolveAndroidBrowserTarget()
    await fs.writeFile(
      serviceComposePath,
      androidWebRtcServicesComposeYaml(servicePorts),
    )
    run(
      'docker',
      androidWebRtcComposeArgs(serviceComposePath, 'up', composeProjectName),
      repoRoot,
    )
    servicesStarted = true
    await Promise.all([
      waitForPort(servicePorts.mqttWsHostPort, timeoutMs),
      waitForPort(servicePorts.turnHostPort, timeoutMs),
    ])
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
        '--target=chrome112',
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
        '--target=chrome112',
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
        '--target=chrome112',
        '--minify',
        '--log-level=silent',
      ],
      repoRoot,
    )

    server = http.createServer(async (request, response) => {
      try {
        await handleHarnessRequest(
          request,
          response,
          bundlePath,
          mqttBundlePath,
          cryptoWorkerBundlePath,
          harnessRequests.record,
          () => {
            if (!readyConfig) {
              throw new Error(
                'Python peer configuration is not ready for the mobile browser',
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
            error: error instanceof Error ? error.message : String(error),
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
        'Android mobile WebRTC harness did not expose a TCP port',
      )
    }

    hostPort = address.port
    run(adb, ['wait-for-device'])
    // Chrome setup writes its first-run preferences directly. Root only the
    // emulator for that browser family; other installed browsers do not need it.
    if (isChromeFamilyBrowser()) {
      spawnSync(adb, ['root'], { stdio: 'ignore' })
      await reconnectTcpAdbAfterRoot()
      run(adb, ['wait-for-device'])
    }
    run(adb, ['shell', 'svc', 'power', 'stayon', 'true'])
    run(adb, ['shell', 'input', 'keyevent', 'KEYCODE_WAKEUP'])
    run(adb, ['shell', 'wm', 'dismiss-keyguard'])
    for (const port of [
      hostPort,
      servicePorts.mqttWsHostPort,
      servicePorts.turnHostPort,
    ]) {
      run(adb, ['reverse', `tcp:${port}`, `tcp:${port}`])
      reversedPorts.add(port)
    }

    const gatewayArgs = [
      'run',
      'python',
      gatewayScript,
      '--lane',
      interopLane,
      '--ready',
      readyPath,
      '--done',
      donePath,
      '--report',
      pythonReportPath,
      '--broker',
      androidWebRtcBrokerUrl(servicePorts),
      '--room',
      room,
      '--timeout',
      String(timeoutMs / 1000),
    ]
    if (stunServer !== undefined) {
      gatewayArgs.push('--stun', stunServer)
    }
    if (turnServer !== undefined) {
      gatewayArgs.push('--turn', turnServer)
    }
    pythonPeer = spawn('uv', gatewayArgs, {
      cwd: repoRoot,
      env: {
        ...process.env,
        WEBRTC_INTEROP_ROOM_SECRET: roomSecret,
        WEBRTC_INTEROP_TOKEN: token,
      },
      stdio: 'pipe',
    })
    pythonPeer.stdout.on('data', (chunk) => {
      pythonOutput += String(chunk)
    })
    pythonPeer.stderr.on('data', (chunk) => {
      pythonOutput += String(chunk)
    })

    const browserDiagnostics = (): AndroidBrowserDiagnostics => ({
      harnessRequests: harnessRequests.snapshot(),
      currentActivity: adbOutputOrEmpty([
        'shell',
        'dumpsys',
        'activity',
        'activities',
      ]).slice(-4_000),
      windowHierarchy: readWindowHierarchy(),
      logcatTail: adbOutputOrEmpty(['logcat', '-d', '-t', '300']).slice(
        -8_000,
      ),
    })

    return {
      timeoutMs,
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
      deviceHarnessUrl: `http://127.0.0.1:${hostPort}/`,
      setReadyConfig(value: BrowserConfig) {
        readyConfig = value
      },
      async waitForHarnessLoad(waitMs: number): Promise<void> {
        const deadline = Date.now() + waitMs
        while (Date.now() < deadline) {
          if (harnessRequests.hasAll(['document', 'bundle', 'config'])) {
            return
          }
          await sleep(500)
        }
        throw new Error(
          `Android Chrome did not load the WebRTC harness page: ${JSON.stringify(browserDiagnostics())}`,
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
            sleep(2_000).then(() => ({ type: 'poll' as const })),
          ])
          if (outcome.type === 'result') return outcome.value
          const logcat = adbOutputOrEmpty([
            'logcat',
            '-d',
            '-t',
            '300',
          ])
          if (
            /renderProcessGone\(\)|exited due to signal 5 \(Trap\)/u.test(
              logcat,
            )
          ) {
            throw new Error(
              'Android Chrome renderer crashed during WebRTC interoperability; inspect logcat and verify the emulator has hardware acceleration',
            )
          }
        }
        throw new Error(
          `Timed out waiting for Android mobile browser interop result after ${waitMs}ms: ${JSON.stringify(browserDiagnostics())}`,
        )
      },
      close,
    }
  } catch (error) {
    await close()
    throw error
  }
}

async function handleHarnessRequest(
  request: IncomingMessage,
  response: ServerResponse,
  bundlePath: string,
  mqttBundlePath: string,
  cryptoWorkerBundlePath: string,
  recordRequest: (
    kind: 'document' | 'bundle' | 'config' | 'result' | 'asset',
    path: string,
    method?: string,
  ) => void,
  getConfig: () => Record<string, unknown>,
  publishResult: (result: MobileResult) => void,
): Promise<void> {
  const requestUrl = new URL(
    request.url ?? '/',
    `http://${request.headers.host ?? '127.0.0.1'}`,
  )
  if (requestUrl.pathname === '/mqtt-bundle.mjs') {
    recordRequest('asset', requestUrl.pathname, request.method)
    response.writeHead(200, {
      'content-type': 'application/javascript',
      'cache-control': 'no-store',
    })
    response.end(await fs.readFile(mqttBundlePath))
    return
  }
  if (requestUrl.pathname === '/android-mobile-browser-bundle.js') {
    recordRequest('bundle', requestUrl.pathname, request.method)
    response.writeHead(200, {
      'content-type': 'application/javascript',
      'cache-control': 'no-store',
    })
    response.end(await fs.readFile(bundlePath))
    return
  }
  if (requestUrl.pathname === '/crypto-worker-bundle.js') {
    recordRequest('asset', requestUrl.pathname, request.method)
    response.writeHead(200, {
      'content-type': 'application/javascript',
      'cache-control': 'no-store',
    })
    response.end(await fs.readFile(cryptoWorkerBundlePath))
    return
  }
  if (requestUrl.pathname === '/interop-config') {
    recordRequest('config', requestUrl.pathname, request.method)
    response.writeHead(200, {
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
    recordRequest('result', requestUrl.pathname, request.method)
    const value = JSON.parse(
      await readRequestBody(request, 2 * 1024 * 1024),
    ) as MobileResult
    publishResult(value)
    response.writeHead(204, { 'cache-control': 'no-store' })
    response.end()
    return
  }
  if (requestUrl.pathname === '/favicon.ico') {
    recordRequest('asset', requestUrl.pathname, request.method)
    response.writeHead(204)
    response.end()
    return
  }
  recordRequest('document', requestUrl.pathname, request.method)
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
    <title>Aurora Android WebRTC Interop</title>
    <script type="importmap">${mqttImportMapJson}</script>
    <style>
      body { font-family: sans-serif; padding: 2rem; }
      [data-status="passed"] { color: #087a32; }
      [data-status="failed"] { color: #a00; }
    </style>
  </head>
  <body>
    <h1>Aurora mobile WebRTC interoperability</h1>
    <p id="status" data-status="running">Connecting to the Python peer…</p>
    <script type="module" src="/android-mobile-browser-bundle.js"></script>
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

async function launchAndroidBrowser(url: string): Promise<void> {
  await resetAndroidBrowserForInterop()
  if (isChromeFamilyBrowser()) {
    startAndroidBrowserUrl('about:blank')
    const activityDeadline = Date.now() + 60_000
    while (Date.now() < activityDeadline) {
      if (isAndroidBrowserForeground()) break
      await sleep(500)
    }
    run(adb, ['shell', 'am', 'force-stop', browserPackage])
  }
  startAndroidBrowserUrl(url)
  await sleep(2_000)
  if (!isAndroidBrowserForeground()) {
    startAndroidBrowserUrl(url, true)
  }
  await dismissAndroidBrowserNotificationPrompt()
}

function startAndroidBrowserUrl(url: string, explicitActivity = false): void {
  const args = [
    'shell',
    'am',
    'start',
    '-a',
    'android.intent.action.VIEW',
    '-c',
    'android.intent.category.BROWSABLE',
    '-d',
    url,
    '--ez',
    'skip_first_run_experience',
    'true',
    '--activity-clear-top',
  ]
  if (explicitActivity && browserComponent) {
    args.push('-n', browserComponent)
  } else {
    args.push('-p', browserPackage)
  }
  run(adb, args)
}

function isAndroidBrowserForeground(): boolean {
  const activities = adbOutputOrEmpty([
    'shell',
    'dumpsys',
    'activity',
    'activities',
  ])
  return (
    activities.includes(`${browserPackage}/`) ||
    activities.includes(`packageName=${browserPackage}`) ||
    activities.includes(`mResumedActivity`) &&
      activities.includes(browserPackage)
  )
}

async function resetAndroidBrowserForInterop(): Promise<void> {
  spawnSync(adb, ['logcat', '-c'], { stdio: 'ignore' })
  run(adb, ['shell', 'pm', 'enable', browserPackage])
  run(adb, ['shell', 'pm', 'clear', browserPackage])
  run(adb, ['shell', 'pm', 'enable', browserPackage])
  if (!isChromeFamilyBrowser()) return

  const preferencesPath =
    `/data/data/${browserPackage}/shared_prefs/` +
    `${browserPackage}_preferences.xml`

  spawnSync(adb, [
    'shell',
    'rm',
    '-f',
    '/data/local/tmp/chrome-command-line',
  ])
  run(adb, [
    'shell',
    [
      'printf %s ' +
        shellQuote(
          'chrome --disable-fre --no-first-run --no-default-browser-check --disable-search-engine-choice-screen',
        ) +
        ' > /data/local/tmp/chrome-command-line',
      'chmod 644 /data/local/tmp/chrome-command-line',
    ].join(' && '),
  ])

  const deadline = Date.now() + 60_000
  let uid = ''
  while (Date.now() < deadline) {
    uid = adbOutputOrEmpty([
      'shell',
      'stat',
      '-c',
      '%u',
      `/data/data/${browserPackage}`,
    ]).trim()
    if (/^\d+$/.test(uid)) break
    await sleep(500)
  }
  if (!/^\d+$/.test(uid)) {
    throw new Error(
      `Could not initialize ${browserPackage} for the Android browser interop test`,
    )
  }

  const preferences = [
    "<?xml version='1.0' encoding='utf-8' standalone='yes' ?>",
    '<map>',
    '  <boolean name="first_run_flow" value="true" />',
    '  <boolean name="skip_welcome_page" value="true" />',
    '  <boolean name="first_run_tos_accepted" value="true" />',
    '  <int name="Chrome.NotificationPermission.RequestCount" value="1" />',
    `  <long name="Chrome.NotificationPermission.RationaleTimestamp" value="${Date.now()}" />`,
    '</map>',
    '',
  ].join('\n')
  const encoded = Buffer.from(preferences).toString('base64')
  run(adb, [
    'shell',
    [
      `mkdir -p /data/data/${browserPackage}/shared_prefs`,
      `echo ${encoded} | base64 -d > ${preferencesPath}`,
      `chown ${uid}:${uid} ${preferencesPath}`,
      `chmod 660 ${preferencesPath}`,
      `restorecon -R /data/data/${browserPackage}`,
    ].join(' && '),
  ])
  spawnSync(
    adb,
    [
      'shell',
      'pm',
      'set-permission-flags',
      browserPackage,
      'android.permission.POST_NOTIFICATIONS',
      'user-set',
    ],
    { stdio: 'ignore' },
  )
  spawnSync(
    adb,
    [
      'shell',
      'appops',
      'set',
      browserPackage,
      'POST_NOTIFICATION',
      'ignore',
    ],
    { stdio: 'ignore' },
  )
}

async function dismissAndroidBrowserNotificationPrompt(): Promise<void> {
  if (!isChromeFamilyBrowser()) return
  const deadline = Date.now() + 45_000
  while (Date.now() < deadline) {
    spawnSync(
      adb,
      [
        'shell',
        'uiautomator',
        'dump',
        '/sdcard/aurora-window.xml',
      ],
      { stdio: 'ignore' },
    )
    const hierarchy = adbOutputOrEmpty([
      'shell',
      'cat',
      '/sdcard/aurora-window.xml',
    ])
    const promptNode = hierarchy
      .split('/>')
      .find(
        (node) =>
          node.includes(
            `resource-id="${browserPackage}:id/negative_button"`,
          ) || node.includes('text="No thanks"'),
      )
    if (promptNode) {
      const bounds = /bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/u.exec(
        promptNode,
      )
      if (bounds) {
        const x = Math.floor((Number(bounds[1]) + Number(bounds[3])) / 2)
        const y = Math.floor((Number(bounds[2]) + Number(bounds[4])) / 2)
        run(adb, ['shell', 'input', 'tap', String(x), String(y)])
      }
      return
    }
    if (
      hierarchy.includes('Aurora mobile WebRTC interoperability') ||
      hierarchy.includes('Paired with the Python peer over WebRTC') ||
      hierarchy.includes('WebRTC interoperability failed')
    ) {
      return
    }
    await sleep(500)
  }
}

function readWindowHierarchy(): string {
  spawnSync(
    adb,
    ['shell', 'uiautomator', 'dump', '/sdcard/aurora-window.xml'],
    { stdio: 'ignore' },
  )
  return adbOutputOrEmpty([
    'shell',
    'cat',
    '/sdcard/aurora-window.xml',
  ]).slice(-8_000)
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`
}

function adbOutputOrEmpty(args: string[]): string {
  const result = spawnSync(adb, args, { encoding: 'utf8' })
  return result.status === 0 ? result.stdout : ''
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
      throw new Error('Android mobile interop result exceeded the size limit')
    }
    chunks.push(buffer)
  }
  return Buffer.concat(chunks).toString('utf8')
}

async function resolveHostIpv4(): Promise<string> {
  return new Promise((resolvePromise, rejectPromise) => {
    const socket = dgram.createSocket('udp4')
    const closeWithError = (error: Error) => {
      socket.close()
      rejectPromise(error)
    }
    socket.once('error', closeWithError)
    socket.connect(9, '192.0.2.1', () => {
      const address = socket.address()
      socket.off('error', closeWithError)
      socket.close()
      if (typeof address === 'string' || !address.address) {
        rejectPromise(
          new Error(
            'Could not resolve a host IPv4 address for Android WebRTC interop',
          ),
        )
        return
      }
      resolvePromise(address.address)
    })
  })
}

function resolveAdbCommand(): string {
  const candidates = [
    process.env.ADB,
    process.env.ANDROID_HOME
      ? join(process.env.ANDROID_HOME, 'platform-tools', 'adb')
      : undefined,
    process.env.ANDROID_SDK_ROOT
      ? join(process.env.ANDROID_SDK_ROOT, 'platform-tools', 'adb')
      : undefined,
    join(os.homedir(), 'Android/Sdk/platform-tools/adb'),
    join(os.homedir(), '.local/share/android-sdk/platform-tools/adb'),
    'adb',
  ].filter((candidate): candidate is string => Boolean(candidate))
  return (
    candidates.find(
      (candidate) =>
        candidate === 'adb' ||
        (existsSync(candidate) &&
          spawnSync(candidate, ['version'], { stdio: 'ignore' }).status ===
            0),
    ) ?? 'adb'
  )
}

function assertAndroidDevicePreflight(label: string): void {
  const serial = process.env.ANDROID_SERIAL?.trim()
  const state = spawnSync(adb, ['get-state'], { encoding: 'utf8' })
  if (state.status !== 0 || state.stdout.trim() !== 'device') {
    throw new Error(
      `${label} requires a connected API35 x86_64 QEMU device${
        serial ? ` selected by ANDROID_SERIAL=${serial}` : ''
      }; adb get-state returned ${JSON.stringify(
        state.stdout.trim() || state.stderr.trim() || 'no-device',
      )}`,
    )
  }

  const qemu = adbOutput(['shell', 'getprop', 'ro.kernel.qemu']).trim()
  const sdk = adbOutput(['shell', 'getprop', 'ro.build.version.sdk']).trim()
  const abi = adbOutput(['shell', 'getprop', 'ro.product.cpu.abi']).trim()
  if (qemu !== '1' || sdk !== '35' || abi !== 'x86_64') {
    throw new Error(
      `${label} requires API35 x86_64 QEMU; got ro.kernel.qemu=${qemu}, sdk=${sdk}, abi=${abi}`,
    )
  }
}

function resolveAndroidBrowserTarget(): void {
  const preferredPackage = configuredBrowserPackage ?? 'com.android.chrome'
  if (androidPackageInstalled(preferredPackage)) {
    browserPackage = preferredPackage
    browserComponent = resolveBrowserComponent(preferredPackage)
    return
  }
  if (configuredBrowserPackage) {
    throw new Error(
      `Configured Android browser package is not installed: ${configuredBrowserPackage}`,
    )
  }

  const output = adbOutputOrEmpty([
    'shell',
    'cmd',
    'package',
    'resolve-activity',
    '--brief',
    '-a',
    'android.intent.action.VIEW',
    '-c',
    'android.intent.category.BROWSABLE',
    '-d',
    'https://example.com',
  ])
  const component = parseAndroidComponent(output)
  if (!component) {
    throw new Error(
      'No installed Android browser can handle secure web pages for the mobile WebRTC test',
    )
  }
  browserComponent = component
  browserPackage = component.slice(0, component.indexOf('/'))
}

function androidPackageInstalled(packageName: string): boolean {
  return adbOutputOrEmpty(['shell', 'pm', 'path', packageName])
    .trim()
    .startsWith('package:')
}

function resolveBrowserComponent(packageName: string): string | null {
  return parseAndroidComponent(
    adbOutputOrEmpty([
      'shell',
      'cmd',
      'package',
      'resolve-activity',
      '--brief',
      '-a',
      'android.intent.action.VIEW',
      '-c',
      'android.intent.category.BROWSABLE',
      '-d',
      'https://example.com',
      '-p',
      packageName,
    ]),
  )
}

function parseAndroidComponent(output: string): string | null {
  return (
    output
      .split(/\r?\n/u)
      .map((line) => line.trim())
      .find((line) => /^[A-Za-z0-9._]+\/[A-Za-z0-9._$]+$/u.test(line)) ??
    null
  )
}

function isChromeFamilyBrowser(): boolean {
  return /(?:chrome|chromium)/iu.test(browserPackage)
}

async function reconnectTcpAdbAfterRoot(): Promise<void> {
  const serial = process.env.ANDROID_SERIAL?.trim()
  if (!serial || !serial.includes(':')) return

  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    spawnSync(adb, ['connect', serial], { stdio: 'ignore' })
    const state = spawnSync(adb, ['-s', serial, 'get-state'], {
      encoding: 'utf8',
    })
    if (state.status === 0 && state.stdout.trim() === 'device') return
    await sleep(500)
  }
  throw new Error(`Android emulator did not reconnect after adb root: ${serial}`)
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
      if (child?.exitCode !== null && child?.exitCode !== undefined) {
        const output = childOutput?.()
        throw new Error(
          `Python WebRTC peer exited before ${label} with ${child.exitCode}${
            output ? `: ${redactProcessOutput(output)}` : ''
          }`,
        )
      }
      await sleep(100)
    }
  }
  throw new Error(`Timed out waiting for ${label}`)
}

async function waitForPort(port: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const connected = await new Promise<boolean>((resolvePromise) => {
      const socket = net.connect({ host: '127.0.0.1', port })
      socket.once('connect', () => {
        socket.destroy()
        resolvePromise(true)
      })
      socket.once('error', () => resolvePromise(false))
      socket.setTimeout(500, () => {
        socket.destroy()
        resolvePromise(false)
      })
    })
    if (connected) return
    await sleep(100)
  }
  throw new Error(`Timed out waiting for 127.0.0.1:${port}`)
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
        else rejectPromise(new Error(`Child process exited with ${code}`))
      })
    }),
    sleep(timeoutMs).then(() => {
      throw new Error(`Timed out waiting for child process after ${timeoutMs}ms`)
    }),
  ])
}

function redactProcessOutput(value: string): string {
  return value
    .replace(
      /(WEBRTC_INTEROP_(?:ROOM_SECRET|TOKEN)=)[^\s]+/g,
      '$1[REDACTED]',
    )
    .replace(/([?&](?:token|secret)=)[^&\s]+/gi, '$1[REDACTED]')
    .slice(-4_000)
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
  await fs.writeFile(path, `${JSON.stringify(value, null, 2)}\n`)
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms))
}
