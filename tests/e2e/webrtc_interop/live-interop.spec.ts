import { expect, test } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import crypto from 'node:crypto'
import { readFileSync } from 'node:fs'
import fs from 'node:fs/promises'
import http from 'node:http'
import path from 'node:path'

import {
  assertInteropBrowserResult,
  forbiddenInteropTransportRequests,
  type InteropBrowserResult,
} from './assertions.js'

type BrowserConfig = {
  lane: string
  brokerUrl: string
  expectedStablePeerId: string
  expectedNegotiationRole: 'offerer' | 'answerer'
  timeoutMs: number
  [key: string]: unknown
}

type NetworkRequest = {
  url: string
  resourceType: string
  method: string
}

type ConsoleMessage = {
  type: string
  text: string
}

const root = process.cwd()
const lane = process.env.WEBRTC_INTEROP_LANE ?? 'unconfigured'
const artifactDir =
  process.env.WEBRTC_INTEROP_ARTIFACT_DIR ??
  path.join(root, 'reports', 'webrtc-interop', 'unconfigured')
const readyPath = process.env.WEBRTC_INTEROP_READY
const donePath =
  process.env.WEBRTC_INTEROP_DONE ??
  path.join(artifactDir, 'browser-done.json')
const reportPath =
  process.env.WEBRTC_INTEROP_BROWSER_REPORT ??
  path.join(artifactDir, 'browser-report.json')
const roomSecret = process.env.WEBRTC_INTEROP_ROOM_SECRET ?? ''
const bundlePath = path.join(artifactDir, 'browser-bundle.js')
const mqttBundlePath = path.join(artifactDir, 'mqtt-bundle.mjs')
const cryptoWorkerBundlePath = path.join(
  artifactDir,
  'crypto-worker-bundle.js',
)
const configured = Boolean(
  process.env.WEBRTC_INTEROP_LANE &&
    readyPath &&
    process.env.WEBRTC_INTEROP_DONE &&
    process.env.WEBRTC_INTEROP_BROWSER_REPORT &&
    process.env.WEBRTC_INTEROP_ARTIFACT_DIR &&
    roomSecret,
)
const ready = readyPath
  ? (JSON.parse(readFileSync(readyPath, 'utf8')) as BrowserConfig)
  : ({
      lane: 'unconfigured',
      brokerUrl: '',
      expectedStablePeerId: '',
      timeoutMs: 45_000,
    } satisfies BrowserConfig)

let server: http.Server
let baseUrl = ''

test.skip(
  !configured,
  'run through scripts/webrtc_interop.sh so the Python peer and signaling services are available',
)

test.beforeAll(async () => {
  await fs.mkdir(artifactDir, { recursive: true })
  execFileSync(
    'pnpm',
    [
      'exec',
      'esbuild',
      path.join(root, 'tests/e2e/webrtc_interop/browser-entry.ts'),
      '--bundle',
      '--format=esm',
      `--outfile=${bundlePath}`,
      '--platform=browser',
      '--target=chrome112,firefox112,safari16',
      '--external:mqtt',
      '--minify',
      '--log-level=silent',
    ],
    { stdio: 'inherit' },
  )
  execFileSync(
    'pnpm',
    [
      'exec',
      'esbuild',
      path.join(root, 'tests/e2e/webrtc_interop/mqtt-entry.ts'),
      '--bundle',
      '--format=esm',
      `--outfile=${mqttBundlePath}`,
      '--platform=browser',
      '--target=chrome112,firefox112,safari16',
      '--minify',
      '--log-level=silent',
    ],
    { stdio: 'inherit' },
  )
  execFileSync(
    'pnpm',
    [
      'exec',
      'esbuild',
      path.join(
        root,
        'packages/aurora-sdk/src/webrtc/crypto-worker.ts',
      ),
      '--bundle',
      '--format=iife',
      `--outfile=${cryptoWorkerBundlePath}`,
      '--platform=browser',
      '--target=chrome112,firefox112,safari16',
      '--minify',
      '--log-level=silent',
    ],
    { stdio: 'inherit' },
  )

  const html =
    '<!doctype html><html><head><meta charset="utf-8"><title>Aurora WebRTC Interop</title></head><body><script type="module" src="/browser-bundle.js"></script></body></html>'
  server = http.createServer(async (request, response) => {
    if (request.url === '/mqtt-bundle.mjs') {
      response.writeHead(200, {
        'content-type': 'application/javascript',
        'cache-control': 'no-store',
      })
      response.end(await fs.readFile(mqttBundlePath))
      return
    }
    if (request.url === '/browser-bundle.js') {
      response.writeHead(200, {
        'content-type': 'application/javascript',
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
    response.writeHead(200, { 'content-type': 'text/html' })
    response.end(html)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') {
    throw new Error('Playwright interop server did not expose a TCP port')
  }
  baseUrl = `http://127.0.0.1:${address.port}`
})

test.afterAll(async () => {
  if (!server) return
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  )
})

test('browser thin shell interoperates with the Python WebRTC peer without HTTP fallback', async ({
  browserName,
  page,
}) => {
  const networkRequests: NetworkRequest[] = []
  const consoleMessages: ConsoleMessage[] = []
  const started = Date.now()
  let browserResult: InteropBrowserResult | undefined

  page.on('request', (request) =>
    networkRequests.push({
      url: request.url(),
      resourceType: request.resourceType(),
      method: request.method(),
    }),
  )
  page.on('console', (message) =>
    consoleMessages.push({
      type: message.type(),
      text: message.text().slice(0, 240),
    }),
  )
  page.on('pageerror', (error) =>
    consoleMessages.push({
      type: 'pageerror',
      text: error.message.slice(0, 240),
    }),
  )

  try {
    await test.step('load the bundled WebView/browser peer', async () => {
      await page.goto(`${baseUrl}/`, { waitUntil: 'load' })
    })

    browserResult = await test.step(
      'complete signaling, bilateral pairing, reconnect, mutation, and revocation',
      async () =>
        await page.evaluate(
          async ({ config, secret }) => {
            const run = (
              globalThis as typeof globalThis & {
                runAuroraWebRtcInterop?: (
                  value: Record<string, unknown>,
                ) => Promise<InteropBrowserResult>
              }
            ).runAuroraWebRtcInterop
            if (!run) {
              throw new Error('runAuroraWebRtcInterop was not installed')
            }
            return await run({ ...config, roomSecret: secret })
          },
          { config: ready, secret: roomSecret },
        ),
    )

    const forbiddenHttp = forbiddenInteropTransportRequests(
      networkRequests,
      baseUrl,
      ready.brokerUrl,
    )

    await test.step(
      'assert protocol, selected ICE path, reconnect, mutation, and revocation behavior',
      async () => {
        assertInteropBrowserResult(browserResult, {
          lane,
          expectedStablePeerId: ready.expectedStablePeerId,
          expectedNegotiationRole: ready.expectedNegotiationRole,
        })
      },
    )

    await test.step('assert no HTTP transport fallback or unexpected request', async () => {
      expect(forbiddenHttp).toEqual([])
    })

    await writeReport(reportPath, {
      lane,
      browserName,
      status: 'passed',
      durationMs: Date.now() - started,
      command: `pnpm exec playwright test --config tests/e2e/webrtc_interop/playwright.config.ts --project ${browserName}`,
      browserResult,
      noHttpFetchTransportUsed:
        browserResult.noHttpFetchTransportUsed === true,
      networkRequestCount: networkRequests.length,
      forbiddenHttpRequests: forbiddenHttp,
      consoleMessages,
      reportDigest: crypto
        .createHash('sha256')
        .update(JSON.stringify(browserResult))
        .digest('hex'),
      secretsRedacted: true,
    })
    await writeReport(donePath, {
      ok: true,
      at: new Date().toISOString(),
    })
  } catch (error) {
    await writeReport(reportPath, {
      lane,
      browserName,
      status: 'failed',
      durationMs: Date.now() - started,
      error: error instanceof Error ? error.message : String(error),
      browserResult,
      networkRequests,
      consoleMessages,
      secretsRedacted: true,
    })
    await writeReport(donePath, {
      ok: false,
      at: new Date().toISOString(),
    })
    throw error
  }
})

async function writeReport(
  outputPath: string,
  value: Record<string, unknown>,
): Promise<void> {
  await fs.mkdir(path.dirname(outputPath), { recursive: true })
  await fs.writeFile(outputPath, `${JSON.stringify(value, null, 2)}\n`)
}
