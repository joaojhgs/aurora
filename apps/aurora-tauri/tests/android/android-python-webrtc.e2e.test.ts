// @vitest-environment node

import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process'
import crypto from 'node:crypto'
import { existsSync } from 'node:fs'
import fs from 'node:fs/promises'
import http from 'node:http'
import net from 'node:net'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'

import {
  candidatePairMatchesLane,
  type InteropBrowserResult,
} from '../../../../tests/e2e/webrtc_interop/assertions.js'

type BrowserConfig = {
  lane: string
  brokerUrl: string
  expectedStablePeerId: string
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
const serviceScript = resolve(repoRoot, 'scripts/webrtc_interop_services.sh')
const gatewayScript = resolve(repoRoot, 'scripts/webrtc_interop_gateway.py')
const scannerScript = resolve(repoRoot, 'scripts/webrtc_interop_scan.py')
const browserEntry = resolve(
  repoRoot,
  'tests/e2e/webrtc_interop/browser-entry.ts',
)
const appId = process.env.AURORA_ANDROID_APP_ID ?? 'dev.aurora.desktop'
const artifactDir =
  process.env.AURORA_ANDROID_WEBRTC_ARTIFACT_DIR ??
  resolve(appRoot, 'reports/webrtc-interop/android-webview')

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
      const consoleErrors: string[] = []
      const networkRequests: NetworkRequest[] = []
      const client = await connectAndroidWebView(appId, (message) => {
        if (message.method === 'Runtime.exceptionThrown') {
          const details = message.params?.exceptionDetails
          consoleErrors.push(
            String(
              details?.exception?.description ??
                details?.text ??
                'Uncaught Android WebView exception',
            ),
          )
        }
        if (
          message.method === 'Log.entryAdded' &&
          message.params?.entry?.level === 'error'
        ) {
          consoleErrors.push(String(message.params.entry.text))
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
      resources.setCdpClient(client)

      await client.send('Runtime.enable')
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

      const started = Date.now()
      let browserResult: InteropBrowserResult | undefined
      try {
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

        const forbiddenHttp = forbiddenHttpRequests(
          networkRequests,
          resources.deviceHarnessUrl,
          ready.brokerUrl,
        )

        expect(browserResult.authorized).toBe(true)
        expect(
          candidatePairMatchesLane('turn', browserResult.selectedCandidatePair),
        ).toBe(true)
        expect(browserResult.connectedStablePeerId).toBe(
          ready.expectedStablePeerId,
        )
        expect(browserResult.selectedSignalingBrokerOrigin).toBeTruthy()
        expect(browserResult.registryModuleCount).toBeGreaterThan(0)
        expect(browserResult.pendingCallCount).toBe(0)
        expect(browserResult.event).toBeTruthy()
        expect(browserResult.ttsEvent).toBeTruthy()
        expect(browserResult.scopedEventEvidence).toEqual({
          wrongCorrelationDelivered: false,
          wildcardDelivered: false,
        })
        expect(browserResult.reconnectEvidence).toMatchObject({
          authorizedWithoutSas: true,
          pendingPairingPrompts: 0,
        })
        expect(
          browserResult.reconnectEvidence.registryModuleCount,
        ).toBeGreaterThan(0)
        expect(
          browserResult.mutationEvidence.uncertainLossWindow
            .startedAckBeforeDisconnect,
        ).toBe(true)
        expect(
          browserResult.mutationEvidence.uncertainLossWindow
            .disconnectBeforeResponseSettled,
        ).toBe(true)
        expect(
          browserResult.mutationEvidence.executionCountAtMostOnce,
        ).toBe(true)
        expect(
          browserResult.mutationEvidence
            .pairingPromptsDuringMutationReconnect,
        ).toBe(0)
        expect(
          browserResult.revocationEvidence.routeAuthorizedAfterRevocation,
        ).toBe(false)
        expect(
          browserResult.revocationEvidence.pendingPairingPrompts,
        ).toBeGreaterThanOrEqual(1)
        expect(browserResult.hostileCaseEvidence.failClosedObserved).toBe(true)
        expect(browserResult.noHttpFetchTransportUsed).toBe(true)
        expect(browserResult.httpFetchCalls).toEqual([])
        expect(forbiddenHttp).toEqual([])
        expect(consoleErrors).toEqual([])

        await writeJson(resources.browserReportPath, {
          lane: 'turn',
          browserName: 'android-webview',
          status: 'passed',
          durationMs: Date.now() - started,
          command:
            'pnpm --filter @aurora/tauri-ui android:webrtc:interop',
          browserResult,
          noHttpFetchTransportUsed: true,
          networkRequestCount: networkRequests.length,
          forbiddenHttpRequests: forbiddenHttp,
          consoleErrors,
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
            'turn',
          ],
          repoRoot,
        )
        const aggregate = await waitForJson<Record<string, unknown>>(
          resources.finalReportPath,
          10_000,
          'aggregate Android WebRTC report',
        )
        expect(aggregate).toMatchObject({
          status: 'passed',
          lane: 'turn',
          pathCategory: 'relay',
          pathCategoryAccepted: true,
          secretsRedacted: true,
        })
      } catch (error) {
        await writeJson(resources.browserReportPath, {
          lane: 'turn',
          browserName: 'android-webview',
          status: 'failed',
          durationMs: Date.now() - started,
          error: error instanceof Error ? error.message : String(error),
          browserResult,
          networkRequests,
          consoleErrors,
          secretsRedacted: true,
        })
        await writeJson(resources.donePath, {
          ok: false,
          at: new Date().toISOString(),
        })
        throw error
      }
    },
    480_000,
  )
})

async function createInteropResources() {
  const timeoutMs = Number(
    process.env.AURORA_ANDROID_WEBRTC_TIMEOUT_MS ?? 180_000,
  )
  const roomSecret = crypto.randomBytes(32).toString('base64url')
  const token = `android.${crypto.randomBytes(24).toString('base64url')}`
  const room = `android-webview-${process.pid}-${Date.now().toString(36)}`
  const readyPath = join(artifactDir, 'gateway-ready.json')
  const donePath = join(artifactDir, 'android-done.json')
  const pythonReportPath = join(artifactDir, 'python-gateway-report.json')
  const browserReportPath = join(artifactDir, 'android-webview-report.json')
  const finalReportPath = join(artifactDir, 'report.json')
  const bundlePath = join(artifactDir, 'android-webview-bundle.js')
  const transientPaths = [
    readyPath,
    donePath,
    pythonReportPath,
    browserReportPath,
    finalReportPath,
    bundlePath,
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
    spawnSync('adb', ['shell', 'am', 'force-stop', appId], {
      stdio: 'ignore',
    })
    for (const port of reversedPorts) {
      spawnSync('adb', ['reverse', '--remove', `tcp:${port}`], {
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
      spawnSync(serviceScript, ['down'], {
        cwd: repoRoot,
        stdio: 'inherit',
      })
    }
    if (
      pythonPeer?.exitCode &&
      pythonPeer.exitCode !== 0 &&
      pythonOutput
    ) {
      console.error(redactProcessOutput(pythonOutput))
    }
  }

  try {
    run(serviceScript, ['up'], repoRoot)
    servicesStarted = true
    await Promise.all([
      waitForPort(9001, timeoutMs),
      waitForPort(3478, timeoutMs),
    ])
    run(
      'pnpm',
      [
        'exec',
        'esbuild',
        browserEntry,
        '--bundle',
        '--format=iife',
        '--global-name=AuroraInteropBundle',
        `--outfile=${bundlePath}`,
        '--platform=browser',
        '--target=chrome83',
        '--log-level=silent',
      ],
      repoRoot,
    )

    server = http.createServer(async (request, response) => {
      if (request.url === '/android-webview-bundle.js') {
        response.writeHead(200, {
          'content-type': 'application/javascript',
          'cache-control': 'no-store',
        })
        response.end(await fs.readFile(bundlePath))
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
        '<!doctype html><html><head><meta charset="utf-8"><title>Aurora Android WebRTC Interop</title></head><body><script src="/android-webview-bundle.js"></script></body></html>',
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
    ensureAndroidAppInstalled()
    for (const port of [hostPort, 9001, 3478]) {
      run('adb', ['reverse', `tcp:${port}`, `tcp:${port}`])
      reversedPorts.add(port)
    }
    run('adb', ['shell', 'am', 'force-stop', appId])
    run('adb', [
      'shell',
      'monkey',
      '-p',
      appId,
      '-c',
      'android.intent.category.LAUNCHER',
      '1',
    ])

    pythonPeer = spawn(
      'uv',
      [
        'run',
        'python',
        gatewayScript,
        '--lane',
        'turn',
        '--ready',
        readyPath,
        '--done',
        donePath,
        '--report',
        pythonReportPath,
        '--broker',
        'ws://127.0.0.1:9001/mqtt',
        '--room',
        room,
        '--turn',
        'turn:127.0.0.1:3478?transport=tcp',
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
      roomSecret,
      readyPath,
      donePath,
      pythonReportPath,
      browserReportPath,
      finalReportPath,
      pythonPeer,
      getPythonOutput: () => pythonOutput,
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

function ensureAndroidAppInstalled(): void {
  const installed = spawnSync('adb', ['shell', 'pm', 'path', appId], {
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
  const deadline = Date.now() + 90_000
  while (Date.now() < deadline) {
    const pid = adbOutput(['shell', 'pidof', packageName])
      .trim()
      .split(/\s+/)[0]
    if (!pid) {
      await sleep(500)
      continue
    }
    const socketName = `webview_devtools_remote_${pid}`
    if (
      !adbOutput(['shell', 'cat', '/proc/net/unix']).includes(
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
          spawnSync('adb', ['forward', '--remove', `tcp:${port}`], {
            stdio: 'ignore',
          })
        },
      }
    } catch {
      spawnSync('adb', ['forward', '--remove', `tcp:${port}`], {
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

  return {
    send(
      method: string,
      params: Record<string, unknown> = {},
      timeoutMs = 30_000,
    ): Promise<CdpMessage> {
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
      for (const waiter of pending.values()) {
        clearTimeout(waiter.timer)
        waiter.reject(new Error('Android WebView CDP connection closed'))
      }
      pending.clear()
    },
  }
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
  const expression = `globalThis.runAuroraWebRtcInterop(${JSON.stringify({
    ...config,
    roomSecret,
  })})`
  const response = await client.send(
    'Runtime.evaluate',
    {
      expression,
      awaitPromise: true,
      returnByValue: true,
    },
    timeoutMs + 30_000,
  )
  const exception = response.result?.exceptionDetails
  if (exception) {
    throw new Error(
      String(
        exception.exception?.description ??
          exception.text ??
          'Android WebView interop evaluation failed',
      ),
    )
  }
  const value = response.result?.result?.value
  if (!value || typeof value !== 'object') {
    throw new Error('Android WebView interop returned no structured result')
  }
  return value as InteropBrowserResult
}

function forbiddenHttpRequests(
  requests: NetworkRequest[],
  harnessUrl: string,
  brokerUrl: string,
): NetworkRequest[] {
  const harness = new URL(harnessUrl)
  return requests.filter((request) => {
    if (request.url.startsWith(`blob:${harness.origin}/`)) return false
    try {
      const url = new URL(request.url)
      return !(
        (url.hostname === harness.hostname && url.port === harness.port) ||
        request.url.startsWith(brokerUrl)
      )
    } catch {
      return true
    }
  })
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
  const result = spawnSync('adb', args, { encoding: 'utf8' })
  if (result.error) throw result.error
  if (result.status !== 0) {
    throw new Error(
      `adb ${args.join(' ')} failed: ${`${result.stdout}\n${result.stderr}`.trim()}`,
    )
  }
  return result.stdout
}

function run(command: string, args: string[], cwd = appRoot): void {
  const result = spawnSync(command, args, {
    cwd,
    stdio: 'inherit',
  })
  if (result.error) throw result.error
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(' ')} failed with status ${result.status}`,
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
