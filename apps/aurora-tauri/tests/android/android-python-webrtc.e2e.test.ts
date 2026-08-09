// @vitest-environment node

import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process'
import crypto from 'node:crypto'
import dgram from 'node:dgram'
import { existsSync } from 'node:fs'
import fs from 'node:fs/promises'
import http from 'node:http'
import net from 'node:net'
import os from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'

import {
  assertNoInteropSeededSecrets,
  assertInteropBrowserResult,
  forbiddenInteropTransportRequests,
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
  formatAndroidRuntimeException,
  resolveAndroidWebRtcServicePorts,
  splitAndroidConsoleErrors,
  type AndroidRuntimeExceptionDetails,
} from './android-webrtc-harness-utils.js'

type BrowserConfig = {
  lane: string
  brokerUrl: string
  expectedStablePeerId: string
  expectedNegotiationRole: 'offerer' | 'answerer'
  timeoutMs: number
  [key: string]: unknown
}

type CdpMessage = {
  id?: number
  method?: string
  params?: Record<string, any>
  result?: Record<string, any>
  error?: { message?: string }
}

type NetworkRequest = {
  url: string
  kind: 'http' | 'websocket'
}

const repoRoot = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../../..',
)
const appRoot = resolve(repoRoot, 'apps/aurora-tauri')
process.env.COMPOSE_PROJECT_NAME ||= 'aurora-android-webview-webrtc-e2e'
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
const appId = process.env.AURORA_ANDROID_APP_ID ?? 'dev.aurora.desktop'
const artifactDir =
  process.env.AURORA_ANDROID_WEBRTC_ARTIFACT_DIR ??
  resolve(appRoot, 'reports/webrtc-interop/android-webview')
const interopTimeoutMs = Number(
  process.env.AURORA_ANDROID_WEBRTC_TIMEOUT_MS ?? 180_000,
)
const adb = resolveAdbCommand()
const interopLane = (() => {
  const lane = process.env.AURORA_ANDROID_WEBRTC_LANE ?? 'turn'
  if (lane !== 'direct' && lane !== 'stun' && lane !== 'turn') {
    throw new Error(
      `AURORA_ANDROID_WEBRTC_LANE must be direct, stun, or turn; received ${lane}`,
    )
  }
  return lane
})()
const testTimeoutMs = Math.max(480_000, interopTimeoutMs + 120_000)

let cleanup: (() => Promise<void>) | undefined

afterEach(async () => {
  await cleanup?.()
  cleanup = undefined
})

describe('Android thin-shell WebRTC interoperability', () => {
  it(
    'pairs the packaged Android WebView with the Python peer and stays on the encrypted DataChannel path',
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
      const runtimeExceptions: AndroidRuntimeExceptionDetails[] = []
      const consoleLogErrors: string[] = []
      const networkRequests: NetworkRequest[] = []
      const started = Date.now()
      let browserResult: InteropBrowserResult | undefined
      let cdpClient: Awaited<ReturnType<typeof connectCdp>> | undefined
      let renderedConsoleErrors: string[] | undefined
      const getConsoleErrors = async (): Promise<string[]> => {
        if (renderedConsoleErrors !== undefined) {
          return renderedConsoleErrors
        }
        renderedConsoleErrors = [
          ...(await formatRuntimeExceptions(
            cdpClient,
            runtimeExceptions,
          )),
          ...consoleLogErrors,
        ]
        return renderedConsoleErrors
      }
      try {
        const client = await connectAndroidWebView(appId, (message) => {
          if (message.method === 'Runtime.exceptionThrown') {
            runtimeExceptions.push(
              message.params?.exceptionDetails as AndroidRuntimeExceptionDetails,
            )
          }
          if (
            message.method === 'Log.entryAdded' &&
            message.params?.entry?.level === 'error'
          ) {
            consoleLogErrors.push(String(message.params.entry.text))
          }
          if (message.method === 'Network.requestWillBeSent') {
            networkRequests.push({
              url: String(message.params?.request?.url ?? ''),
              kind: 'http',
            })
          }
          if (message.method === 'Network.webSocketCreated') {
            networkRequests.push({
              url: String(message.params?.url ?? ''),
              kind: 'websocket',
            })
          }
        })
        cdpClient = client
        resources.setCdpClient(client)

        await client.send('Runtime.enable')
        await client.send('Debugger.enable')
        await client.send('Log.enable')
        await client.send('Network.enable')
        await client.send('Page.enable')
        await client.send('Page.navigate', {
          url: resources.deviceHarnessUrl,
        })
        await waitForRuntimeExpression(
          client,
          "document.readyState === 'complete' && typeof globalThis.runAuroraWebRtcInterop === 'function'",
          resources.timeoutMs,
          'Android WebView interop bundle',
        )

        browserResult = await evaluateInterop(
          client,
          {
            ...ready,
            runtimeLocation: {
              protocol: 'http:',
              hostname: '127.0.0.1',
            },
          },
          resources.roomSecret,
          resources.timeoutMs,
        )
        const filteredConsoleErrors = splitAndroidConsoleErrors(
          await getConsoleErrors(),
        )
        resources.assertNoSeededSecrets({
          browserResult,
          networkRequests,
          consoleErrors: filteredConsoleErrors.actionable,
          ignoredConsoleErrors:
            filteredConsoleErrors.ignoredTauriBootstrap,
        })

        const forbiddenHttp = forbiddenInteropTransportRequests(
          networkRequests,
          resources.deviceHarnessUrl,
          ready.brokerUrl,
        )

        assertInteropBrowserResult(browserResult, {
          lane: interopLane,
          expectedStablePeerId: ready.expectedStablePeerId,
          expectedNegotiationRole: ready.expectedNegotiationRole,
        })
        expect(forbiddenHttp).toEqual([])
        expect(filteredConsoleErrors.actionable).toEqual([])

        await writeJson(resources.browserReportPath, {
          lane: interopLane,
          browserName: 'android-webview',
          status: 'passed',
          durationMs: Date.now() - started,
          command:
            'pnpm --filter @aurora/tauri-ui android:webrtc:interop',
          browserResult,
          noHttpFetchTransportUsed: true,
          networkRequestCount: networkRequests.length,
          forbiddenHttpRequests: forbiddenHttp,
          consoleErrors: filteredConsoleErrors.actionable,
          ignoredConsoleErrors:
            filteredConsoleErrors.ignoredTauriBootstrap,
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
          'aggregate Android WebRTC report',
        )
        resources.assertNoSeededSecrets(aggregate)
        expect(aggregate).toMatchObject({
          status: 'passed',
          lane: interopLane,
          pathCategoryAccepted: true,
          secretsRedacted: true,
        })
      } catch (error) {
        const redactedError = resources.redactArtifactValue(
          error instanceof Error ? error.message : String(error),
        )
        const filteredConsoleErrors = splitAndroidConsoleErrors(
          await getConsoleErrors(),
        )
        const failureReport = resources.redactArtifactValue({
          lane: interopLane,
          browserName: 'android-webview',
          status: 'failed',
          durationMs: Date.now() - started,
          error: redactedError,
          browserResult,
          networkRequests,
          consoleErrors: filteredConsoleErrors.actionable,
          ignoredConsoleErrors:
            filteredConsoleErrors.ignoredTauriBootstrap,
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
  const token = `android.${crypto.randomBytes(24).toString('base64url')}`
  const seededSecrets = [roomSecret, token]
  const room = `android-webview-${process.pid}-${Date.now().toString(36)}`
  const stunServer =
    interopLane === 'stun'
      ? (process.env.AURORA_ANDROID_WEBRTC_STUN_URL ??
        androidWebRtcStunUrl(await resolveHostIpv4(), servicePorts))
      : undefined
  const turnServer =
    interopLane === 'turn'
      ? (process.env.AURORA_ANDROID_WEBRTC_TURN_URL ??
        androidWebRtcTurnUrl(await resolveHostIpv4(), servicePorts))
      : undefined
  const readyPath = join(artifactDir, 'gateway-ready.json')
  const donePath = join(artifactDir, 'android-done.json')
  const pythonReportPath = join(artifactDir, 'python-gateway-report.json')
  const browserReportPath = join(artifactDir, 'android-webview-report.json')
  const finalReportPath = join(artifactDir, 'report.json')
  const bundlePath = join(artifactDir, 'android-webview-bundle.js')
  const mqttBundlePath = join(artifactDir, 'mqtt-bundle.mjs')
  const legacyMqttBundlePath = join(artifactDir, 'mqtt-bundle.js')
  const serviceComposePath = join(
    artifactDir,
    'docker-compose.webrtc-interop.generated.yml',
  )
  const cryptoWorkerBundlePath = join(
    artifactDir,
    'crypto-worker-bundle.js',
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
    serviceComposePath,
    cryptoWorkerBundlePath,
  ]
  await fs.mkdir(artifactDir, { recursive: true })
  await Promise.all(
    transientPaths.map((path) => fs.rm(path, { force: true })),
  )

  let servicesStarted = false
  let server: http.Server | undefined
  let pythonPeer: ChildProcessWithoutNullStreams | undefined
  let pythonOutput = ''
  let cdpClient: Awaited<ReturnType<typeof connectCdp>> | undefined
  let hostPort: number | undefined
  const reversedPorts = new Set<number>()
  let closed = false
  const close = async () => {
    if (closed) return
    closed = true
    cdpClient?.close()
    spawnSync(adb, ['shell', 'am', 'force-stop', appId], {
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
    assertAndroidDevicePreflight('Android WebView WebRTC interop')
    ensureAndroidAppInstalled()
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
        '--target=chrome83',
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
        '--target=chrome83',
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
        '--target=chrome83',
        '--minify',
        '--log-level=silent',
      ],
      repoRoot,
    )

    server = http.createServer(async (request, response) => {
      if (request.url === '/mqtt-bundle.mjs') {
        response.writeHead(200, {
          'content-type': 'application/javascript',
          'cache-control': 'no-store',
        })
        response.end(await fs.readFile(mqttBundlePath))
        return
      }
      if (request.url === '/android-webview-bundle.js') {
        response.writeHead(200, {
          'content-type': 'application/javascript',
          'cache-control': 'no-store',
        })
        response.end(await fs.readFile(bundlePath))
        return
      }
      if (request.url === '/crypto-worker-bundle.js') {
        response.writeHead(200, {
          'content-type': 'application/javascript',
          'cache-control': 'no-store',
        })
        response.end(await fs.readFile(cryptoWorkerBundlePath))
        return
      }
      if (request.url === '/favicon.ico') {
        response.writeHead(204)
        response.end()
        return
      }
      response.writeHead(200, {
        'content-type': 'text/html',
        'cache-control': 'no-store',
      })
      response.end(
        `<!doctype html><html><head><meta charset="utf-8"><title>Aurora Android WebRTC Interop</title><script type="importmap">${mqttImportMapJson}</script></head><body><script type="module" src="/android-webview-bundle.js"></script></body></html>`,
      )
    })
    await new Promise<void>((resolvePromise) =>
      server?.listen(0, '127.0.0.1', resolvePromise),
    )
    const address = server.address()
    if (!address || typeof address === 'string') {
      throw new Error('Android WebRTC harness did not expose a TCP port')
    }

    hostPort = address.port
    run('adb', ['wait-for-device'])
    run('adb', ['shell', 'svc', 'power', 'stayon', 'true'])
    run('adb', ['shell', 'input', 'keyevent', 'KEYCODE_WAKEUP'])
    run('adb', ['shell', 'wm', 'dismiss-keyguard'])
    for (const port of [
      hostPort,
      servicePorts.mqttWsHostPort,
      servicePorts.turnHostPort,
    ]) {
      run('adb', ['reverse', `tcp:${port}`, `tcp:${port}`])
      reversedPorts.add(port)
    }
    run('adb', ['shell', 'am', 'force-stop', appId])
    launchAndroidApp(appId)

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
    pythonPeer = spawn(
      'uv',
      gatewayArgs,
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
      roomSecret,
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
      setCdpClient(client: Awaited<ReturnType<typeof connectCdp>>) {
        cdpClient = client
      },
      close,
    }
  } catch (error) {
    await close()
    throw error
  }
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
            'Could not resolve a host IPv4 address for Android TURN interop',
          ),
        )
        return
      }
      resolvePromise(address.address)
    })
  })
}

function ensureAndroidAppInstalled(): void {
  const installed = spawnSync(adb, ['shell', 'pm', 'path', appId], {
    encoding: 'utf8',
  })
  if (installed.status === 0 && installed.stdout.includes('package:')) return

  const apk =
    process.env.AURORA_ANDROID_APK ??
    findFile(
      resolve(
        appRoot,
        'src-tauri/gen/android/app/build/outputs/apk',
      ),
      (path) => path.endsWith('.apk') && !path.endsWith('-unsigned.apk'),
    )
  if (!apk) {
    throw new Error(
      'No installed Aurora Android app or APK was found. Build the thin APK before running Android WebRTC interop.',
    )
  }
  run('adb', ['install', '-r', apk])
}

function findFile(
  root: string,
  predicate: (path: string) => boolean,
): string | undefined {
  if (!existsSync(root)) return undefined
  const entries = spawnSync('find', [root, '-type', 'f'], {
    encoding: 'utf8',
  })
  if (entries.status !== 0) return undefined
  return entries.stdout
    .split(/\r?\n/)
    .filter(Boolean)
    .find(predicate)
}

async function connectAndroidWebView(
  packageName: string,
  onEvent: (message: CdpMessage) => void,
) {
  const deadline = Date.now() + Math.max(90_000, interopTimeoutMs)
  while (Date.now() < deadline) {
    const pid = adbOutputOrEmpty(['shell', 'pidof', packageName])
      .trim()
      .split(/\s+/)[0]
    if (!pid) {
      await sleep(500)
      continue
    }
    const socketName = `webview_devtools_remote_${pid}`
    if (
      !adbOutputOrEmpty(['shell', 'cat', '/proc/net/unix']).includes(
        `@${socketName}`,
      )
    ) {
      await sleep(500)
      continue
    }
    const port = adbOutput([
      'forward',
      'tcp:0',
      `localabstract:${socketName}`,
    ]).trim()
    try {
      const targets = (await fetch(
        `http://127.0.0.1:${port}/json/list`,
      ).then((response) => response.json())) as Array<{
        type?: string
        webSocketDebuggerUrl?: string
      }>
      const target = targets.find(
        (entry) => entry.type === 'page' && entry.webSocketDebuggerUrl,
      )
      if (!target?.webSocketDebuggerUrl) {
        throw new Error('Android WebView did not expose a page target')
      }
      const client = await connectCdp(target.webSocketDebuggerUrl, onEvent)
      return {
        ...client,
        close() {
          client.close()
          spawnSync(adb, ['forward', '--remove', `tcp:${port}`], {
            stdio: 'ignore',
          })
        },
      }
    } catch {
      spawnSync(adb, ['forward', '--remove', `tcp:${port}`], {
        stdio: 'ignore',
      })
      await sleep(500)
    }
  }
  throw new Error('Timed out waiting for the packaged Android WebView')
}

async function connectCdp(
  url: string,
  onEvent: (message: CdpMessage) => void,
) {
  const commandTimeoutMs = Math.min(
    120_000,
    Math.max(30_000, Math.floor(interopTimeoutMs / 5)),
  )
  const socket = new WebSocket(url)
  const pending = new Map<
    number,
    {
      resolve: (message: CdpMessage) => void
      reject: (error: Error) => void
      timer: NodeJS.Timeout
    }
  >()
  let sequence = 0
  let closed = false

  const rejectPending = (error: Error) => {
    if (closed) return
    closed = true
    for (const waiter of pending.values()) {
      clearTimeout(waiter.timer)
      waiter.reject(error)
    }
    pending.clear()
  }

  await new Promise<void>((resolvePromise, rejectPromise) => {
    socket.addEventListener('open', () => resolvePromise(), { once: true })
    socket.addEventListener(
      'error',
      () => rejectPromise(new Error('Android WebView CDP connection failed')),
      { once: true },
    )
  })
  socket.addEventListener('message', (event) => {
    const message = JSON.parse(String(event.data)) as CdpMessage
    if (message.id && pending.has(message.id)) {
      const waiter = pending.get(message.id)!
      pending.delete(message.id)
      clearTimeout(waiter.timer)
      if (message.error) {
        waiter.reject(
          new Error(
            `Android WebView CDP command failed: ${message.error.message ?? 'unknown error'}`,
          ),
        )
      } else {
        waiter.resolve(message)
      }
      return
    }
    onEvent(message)
  })
  socket.addEventListener('close', () => {
    rejectPending(
      new Error(
        'Android WebView CDP connection closed; the app or renderer may have exited',
      ),
    )
  })
  socket.addEventListener('error', () => {
    rejectPending(new Error('Android WebView CDP connection failed'))
  })

  return {
    send(
      method: string,
      params: Record<string, unknown> = {},
      timeoutMs = commandTimeoutMs,
    ): Promise<CdpMessage> {
      if (closed || socket.readyState !== WebSocket.OPEN) {
        return Promise.reject(
          new Error(
            `Android WebView CDP connection is not open: ${method}`,
          ),
        )
      }
      const id = ++sequence
      return new Promise((resolvePromise, rejectPromise) => {
        const timer = setTimeout(() => {
          pending.delete(id)
          rejectPromise(
            new Error(`Android WebView CDP command timed out: ${method}`),
          )
        }, timeoutMs)
        pending.set(id, {
          resolve: resolvePromise,
          reject: rejectPromise,
          timer,
        })
        socket.send(JSON.stringify({ id, method, params }))
      })
    },
    close() {
      socket.close()
      rejectPending(new Error('Android WebView CDP connection closed'))
    },
  }
}

async function formatRuntimeExceptions(
  client: Awaited<ReturnType<typeof connectCdp>> | undefined,
  exceptions: AndroidRuntimeExceptionDetails[],
): Promise<string[]> {
  if (client === undefined) {
    return exceptions.map((details) =>
      formatAndroidRuntimeException(details),
    )
  }

  const sources = new Map<string, string | undefined>()
  return Promise.all(
    exceptions.map(async (details) => {
      const scriptId = details.scriptId
      if (typeof scriptId !== 'string') {
        return formatAndroidRuntimeException(details)
      }
      if (!sources.has(scriptId)) {
        try {
          const response = await client.send('Debugger.getScriptSource', {
            scriptId,
          })
          const source = response.result?.scriptSource
          sources.set(
            scriptId,
            typeof source === 'string' ? source : undefined,
          )
        } catch {
          sources.set(scriptId, undefined)
        }
      }
      return formatAndroidRuntimeException(details, sources.get(scriptId))
    }),
  )
}

async function waitForRuntimeExpression(
  client: Awaited<ReturnType<typeof connectCdp>>,
  expression: string,
  timeoutMs: number,
  label: string,
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const response = await client.send('Runtime.evaluate', {
      expression,
      returnByValue: true,
    })
    if (response.result?.result?.value === true) return
    await sleep(250)
  }
  throw new Error(`Timed out waiting for ${label}`)
}

async function evaluateInterop(
  client: Awaited<ReturnType<typeof connectCdp>>,
  config: BrowserConfig,
  roomSecret: string,
  timeoutMs: number,
): Promise<InteropBrowserResult> {
  const outcomeKey = `__auroraWebRtcInteropOutcome_${crypto
    .randomBytes(8)
    .toString('hex')}`
  const expression = `(() => {
    const outcomeKey = ${JSON.stringify(outcomeKey)};
    globalThis[outcomeKey] = { status: 'running' };
    Promise.resolve(globalThis.runAuroraWebRtcInterop(${JSON.stringify({
    ...config,
    roomSecret,
  })})).then(
      (result) => { globalThis[outcomeKey] = { status: 'passed', result }; },
      (error) => {
        globalThis[outcomeKey] = {
          status: 'failed',
          error: {
            name: error?.name ?? 'Error',
            message: error?.message ?? String(error),
            stack: error?.stack ?? ''
          }
        };
      }
    );
    return true;
  })()`
  await client.send(
    'Runtime.evaluate',
    {
      expression,
      returnByValue: true,
    },
  )

  const deadline = Date.now() + timeoutMs
  let lastProgress: unknown = null
  try {
    while (Date.now() < deadline) {
      const response = await client.send('Runtime.evaluate', {
        expression: `JSON.stringify({
          outcome: globalThis[${JSON.stringify(outcomeKey)}],
          progress: globalThis.__auroraWebRtcInteropProgress ?? null,
          signaling:
            typeof globalThis.__auroraWebRtcInteropSignalingDiagnostics === 'function'
              ? globalThis.__auroraWebRtcInteropSignalingDiagnostics()
              : null,
          peerConnection:
            globalThis.__auroraWebRtcInteropPeerConnectionDiagnostics ?? null
        })`,
        returnByValue: true,
      })
      const value = response.result?.result?.value
      if (typeof value !== 'string') {
        throw new Error(
          'Android WebView interop returned no structured poll result',
        )
      }
      const polled = JSON.parse(value) as {
        outcome?: {
          status?: string
          result?: InteropBrowserResult
          error?: { message?: string; stack?: string }
        }
        progress?: unknown
        signaling?: unknown
        peerConnection?: unknown
      }
      lastProgress = {
        progress: polled.progress,
        signaling: polled.signaling,
        peerConnection: polled.peerConnection,
      }
      if (polled.outcome?.status === 'passed' && polled.outcome.result) {
        return polled.outcome.result
      }
      if (polled.outcome?.status === 'failed') {
        throw new Error(
          polled.outcome.error?.stack ||
            polled.outcome.error?.message ||
            'Android WebView interop evaluation failed',
        )
      }
      await sleep(500)
    }
    throw new Error(
      `Timed out waiting for Android WebView interop result; last progress: ${JSON.stringify(lastProgress)}`,
    )
  } finally {
    await client
      .send('Runtime.evaluate', {
        expression: `delete globalThis[${JSON.stringify(outcomeKey)}]`,
      })
      .catch(() => undefined)
  }
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
    await sleep(200)
  }
  throw new Error(`Timed out waiting for localhost:${port}`)
}

async function waitForChild(
  child: ChildProcessWithoutNullStreams,
  timeoutMs: number,
): Promise<void> {
  if (child.exitCode !== null) {
    if (child.exitCode !== 0) {
      throw new Error(`Python WebRTC peer exited with ${child.exitCode}`)
    }
    return
  }
  await new Promise<void>((resolvePromise, rejectPromise) => {
    const timer = setTimeout(() => {
      rejectPromise(new Error('Timed out waiting for Python WebRTC peer'))
    }, timeoutMs)
    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      clearTimeout(timer)
      if (code === 0) {
        resolvePromise()
      } else {
        rejectPromise(
          new Error(
            `Python WebRTC peer exited with ${code ?? `signal ${signal}`}`,
          ),
        )
      }
    }
    child.once('exit', onExit)
    if (child.exitCode !== null) {
      child.removeListener('exit', onExit)
      onExit(child.exitCode, child.signalCode)
    }
  })
}

function adbOutput(args: string[]): string {
  const result = spawnSync(adb, args, { encoding: 'utf8' })
  if (result.error) throw result.error
  if (result.status !== 0) {
    throw new Error(
      `${adb} ${args.join(' ')} failed: ${`${result.stdout}\n${result.stderr}`.trim()}`,
    )
  }
  return result.stdout
}

function adbOutputOrEmpty(args: string[]): string {
  const result = spawnSync(adb, args, { encoding: 'utf8' })
  if (result.error) throw result.error
  return result.status === 0 ? result.stdout : ''
}

function run(command: string, args: string[], cwd = appRoot): void {
  const resolvedCommand = command === 'adb' ? adb : command
  const result = spawnSync(resolvedCommand, args, {
    cwd,
    stdio: 'inherit',
  })
  if (result.error) throw result.error
  if (result.status !== 0) {
    throw new Error(
      `${resolvedCommand} ${args.join(' ')} failed with status ${result.status}`,
    )
  }
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
        (candidate === 'adb'
          || existsSync(candidate))
        && spawnSync(candidate, ['version'], { stdio: 'ignore' }).status === 0,
    ) ?? 'adb'
  )
}

function launchAndroidApp(packageId: string): void {
  const component = `${packageId}/.MainActivity`
  const direct = spawnSync(
    adb,
    ['shell', 'am', 'start', '-W', '-n', component],
    { cwd: appRoot, encoding: 'utf8' },
  )
  if (direct.error) throw direct.error
  if (direct.status === 0) return

  const fallback = spawnSync(
    adb,
    [
      'shell',
      'monkey',
      '-p',
      packageId,
      '-c',
      'android.intent.category.LAUNCHER',
      '1',
    ],
    { cwd: appRoot, encoding: 'utf8' },
  )
  if (fallback.error) throw fallback.error
  if (fallback.status !== 0) {
    const detail = `${direct.stdout ?? ''}\n${direct.stderr ?? ''}\n${fallback.stdout ?? ''}\n${fallback.stderr ?? ''}`.trim()
    throw new Error(`Could not launch ${component}: ${detail}`)
  }
}

async function writeJson(
  path: string,
  value: Record<string, unknown>,
): Promise<void> {
  await fs.mkdir(dirname(path), { recursive: true })
  await fs.writeFile(path, `${JSON.stringify(value, null, 2)}\n`)
}

function redactProcessOutput(value: string): string {
  return value
    .replaceAll(
      /(room[_-]?secret|password|token)=\S+/gi,
      '$1=<redacted>',
    )
    .slice(-4_000)
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolvePromise) =>
    setTimeout(resolvePromise, milliseconds),
  )
}
