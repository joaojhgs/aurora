#!/usr/bin/env node
import { chromium, firefox, webkit } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import http from 'node:http'
import fs from 'node:fs/promises'
import path from 'node:path'
import crypto from 'node:crypto'

const root = process.cwd()
const args = new Map(process.argv.slice(2).map((arg, index, all) => arg.startsWith('--') ? [arg.slice(2), all[index + 1] && !all[index + 1].startsWith('--') ? all[index + 1] : 'true'] : []))
const lane = args.get('lane') || 'direct'
const browserName = args.get('browser') || 'chromium'
const readyPath = args.get('ready')
const donePath = args.get('done')
const reportPath = args.get('report')
const artifactDir = args.get('artifact-dir') || path.join(root, 'reports', 'webrtc-interop', lane)
if (!readyPath || !donePath || !reportPath) throw new Error('--ready, --done, and --report are required')
const roomSecret = process.env.WEBRTC_INTEROP_ROOM_SECRET
if (!roomSecret) throw new Error('WEBRTC_INTEROP_ROOM_SECRET is required but is never written to the report')

const bundlePath = path.join(artifactDir, 'browser-bundle.js')
await fs.mkdir(artifactDir, { recursive: true })
execFileSync('pnpm', [
  'exec', 'esbuild',
  path.join(root, 'tests/e2e/webrtc_interop/browser-entry.ts'),
  '--bundle',
  '--format=iife',
  '--global-name=AuroraInteropBundle',
  `--outfile=${bundlePath}`,
  '--platform=browser',
  '--target=chrome112,firefox112,safari16',
  '--log-level=silent'
], { stdio: 'inherit' })

const html = '<!doctype html><html><head><meta charset="utf-8"><title>Aurora WebRTC Interop</title></head><body><script src="/browser-bundle.js"></script></body></html>'
const server = http.createServer(async (req, res) => {
  if (req.url === '/browser-bundle.js') {
    res.writeHead(200, { 'content-type': 'application/javascript' })
    res.end(await fs.readFile(bundlePath))
    return
  }
  res.writeHead(200, { 'content-type': 'text/html' })
  res.end(html)
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const port = server.address().port

const launchers = { chromium, firefox, webkit }
const launcher = launchers[browserName]
if (!launcher) throw new Error(`Unsupported browser ${browserName}`)

const ready = JSON.parse(await fs.readFile(readyPath, 'utf8'))
const networkRequests = []
const consoleMessages = []
const started = Date.now()
let browser
try {
  const launchOptions = browserName === 'chromium'
    ? { headless: true, args: ['--disable-features=WebRtcHideLocalIpsWithMdns'] }
    : browserName === 'firefox' && ready.suppressHostCandidates === true
      ? {
          headless: true,
          firefoxUserPrefs: {
            // Firefox accepts local loopback host pairs even when trickled host
            // candidates are filtered. Disable host candidates in the harness
            // so the STUN lane must nominate the gathered reflexive candidate.
            'media.peerconnection.ice.no_host': true
          }
        }
      : { headless: true }
  browser = await launcher.launch(launchOptions)
  const context = await browser.newContext()
  const page = await context.newPage()
  page.on('request', (request) => networkRequests.push({ url: request.url(), resourceType: request.resourceType(), method: request.method() }))
  page.on('console', (message) => consoleMessages.push({ type: message.type(), text: message.text().slice(0, 240) }))
  page.on('pageerror', (error) => consoleMessages.push({ type: 'pageerror', text: error.message.slice(0, 240) }))
  await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'load' })
  const browserResult = await page.evaluate(async (config) => {
    return await globalThis.runAuroraWebRtcInterop(config)
  }, { ...ready, roomSecret })

  const forbiddenHttp = networkRequests.filter((request) => {
    const url = new URL(request.url)
    if (url.protocol === 'blob:' && request.url.startsWith(`blob:http://127.0.0.1:${port}/`)) return false
    return !(url.hostname === '127.0.0.1' && url.port === String(port)) && !request.url.startsWith(ready.brokerUrl)
  })
  const report = {
    lane,
    browserName,
    status: 'passed',
    durationMs: Date.now() - started,
    command: `node scripts/webrtc_interop_browser.mjs --lane ${lane} --browser ${browserName}`,
    browserResult,
    noHttpFetchTransportUsed: browserResult.noHttpFetchTransportUsed === true,
    networkRequestCount: networkRequests.length,
    forbiddenHttpRequests: forbiddenHttp,
    consoleMessages,
    reportDigest: crypto.createHash('sha256').update(JSON.stringify(browserResult)).digest('hex'),
    secretsRedacted: true
  }
  await fs.writeFile(reportPath, JSON.stringify(report, null, 2) + '\n')
  await fs.writeFile(donePath, JSON.stringify({ ok: true, at: new Date().toISOString() }) + '\n')
  if (!browserResult.authorized) throw new Error('Browser did not authorize WebRTC session')
  if (browserResult.httpFetchCalls.length !== 0) throw new Error('HTTP fetch transport was used')
  if (forbiddenHttp.length !== 0) throw new Error('Unexpected non-harness HTTP request observed')
} catch (error) {
  const report = { lane, browserName, status: 'failed', durationMs: Date.now() - started, error: error?.message || String(error), networkRequests, consoleMessages, secretsRedacted: true }
  await fs.writeFile(reportPath, JSON.stringify(report, null, 2) + '\n')
  throw error
} finally {
  await browser?.close().catch(() => undefined)
  await new Promise((resolve) => server.close(resolve))
}
