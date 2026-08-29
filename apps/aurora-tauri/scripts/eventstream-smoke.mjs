import { spawn } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import http from 'node:http'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const appDir = resolve(__dirname, '..')
const reportPath = resolve(appDir, 'reports/eventstream-smoke.json')
const timeoutMs = 180_000

let tauriProcess
let finished = false
let gatewayRequestClosed = false
let gatewayRequestOpened = false
let gatewayRequestUrl = null
let resolveGatewayClosed = () => undefined
const gatewayClosed = new Promise((resolve) => {
  resolveGatewayClosed = resolve
})

const gatewayServer = http.createServer((request, response) => {
  if (request.url?.startsWith('/api/events/stream')) {
    gatewayRequestOpened = true
    gatewayRequestUrl = request.url
    response.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
      'access-control-allow-origin': '*'
    })
    response.write(': aurora eventstream smoke ready\n\n')
    setTimeout(() => {
      response.write(
        `id: smoke-1\ndata: ${JSON.stringify({
          id: 'smoke-1',
          kind: 'health.updated',
          topic: 'Gateway.Health',
          payload: {
            status: 'healthy',
            source: 'eventstream-smoke'
          },
          correlation_id: 'tauri-eventstream-smoke',
          audit: {
            correlation_id: 'tauri-eventstream-smoke',
            transport: 'sse',
            redaction: {
              secrets_redacted: true,
              source: 'eventstream-smoke-gateway'
            }
          }
        })}\n\n`
      )
    }, 250)
    request.on('close', () => {
      gatewayRequestClosed = true
      resolveGatewayClosed()
    })
    return
  }

  if (request.url === '/api/health') {
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ ok: true, service: 'eventstream-smoke-gateway' }))
    return
  }

  response.writeHead(404, { 'content-type': 'application/json' })
  response.end(JSON.stringify({ error: 'not_found', secretsRedacted: true }))
})

const reportServer = http.createServer(async (request, response) => {
  if (request.method === 'OPTIONS') {
    writeCors(response, 204)
    response.end()
    return
  }
  if (request.method !== 'POST' || request.url !== '/eventstream-smoke') {
    writeCors(response, 404)
    response.end(JSON.stringify({ error: 'not_found' }))
    return
  }

  const body = await readBody(request)
  const webviewReport = JSON.parse(body)
  await Promise.race([gatewayClosed, delay(5_000)])
  const report = {
    ...webviewReport,
    gateway: {
      streamOpened: gatewayRequestOpened,
      streamClosedAfterUnsubscribe: gatewayRequestClosed,
      requestUrl: gatewayRequestUrl,
      secretsRedacted: true
    },
    ok: Boolean(webviewReport.ok && gatewayRequestOpened && gatewayRequestClosed),
    generatedAt: new Date().toISOString()
  }
  await mkdir(dirname(reportPath), { recursive: true })
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8')
  writeCors(response, report.ok ? 200 : 500)
  response.end(JSON.stringify(report))
  cleanup(report.ok ? 0 : 1)
})

try {
  const gatewayUrl = await listen(gatewayServer)
  const reportUrl = `${await listen(reportServer)}/eventstream-smoke`
  tauriProcess = spawn('pnpm', ['tauri', 'dev'], {
    cwd: appDir,
    detached: process.platform !== 'win32',
    stdio: 'inherit',
    env: {
      ...process.env,
      AURORA_GATEWAY_URL: gatewayUrl,
      VITE_AURORA_EVENTSTREAM_SMOKE: '1',
      VITE_AURORA_EVENTSTREAM_SMOKE_REPORT_URL: reportUrl
    }
  })
  tauriProcess.on('exit', async (code, signal) => {
    if (!finished) {
      await writeFailureReport(
        `Tauri dev exited before EventStream smoke completed: code=${String(code)} signal=${String(signal)}`
      )
      cleanup(1)
    }
  })
  setTimeout(async () => {
    await writeFailureReport('Timed out waiting for Tauri EventStream smoke report')
    cleanup(1)
  }, timeoutMs).unref()
} catch (error) {
  await writeFailureReport(error instanceof Error ? error.message : String(error))
  cleanup(1)
}

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (!address || typeof address === 'string') {
        reject(new Error('server did not bind to a TCP port'))
        return
      }
      resolve(`http://127.0.0.1:${address.port}`)
    })
  })
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    let body = ''
    request.setEncoding('utf8')
    request.on('data', (chunk) => {
      body += chunk
    })
    request.on('end', () => resolve(body))
    request.on('error', reject)
  })
}

function writeCors(response, status) {
  response.writeHead(status, {
    'content-type': 'application/json',
    'access-control-allow-origin': '*',
    'access-control-allow-methods': 'POST, OPTIONS',
    'access-control-allow-headers': 'content-type'
  })
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function writeFailureReport(error) {
  await mkdir(dirname(reportPath), { recursive: true })
  await writeFile(
    reportPath,
    `${JSON.stringify(
      {
        ok: false,
        scenario: 'tauri-local-gateway-sse-to-sdk-subscription',
        error,
        gateway: {
          streamOpened: gatewayRequestOpened,
          streamClosedAfterUnsubscribe: gatewayRequestClosed,
          requestUrl: gatewayRequestUrl,
          secretsRedacted: true
        },
        generatedAt: new Date().toISOString(),
        secretsRedacted: true
      },
      null,
      2
    )}\n`,
    'utf8'
  )
}

function cleanup(exitCode) {
  if (finished && exitCode !== 0) return
  finished = true
  process.exitCode = exitCode
  gatewayServer.close()
  reportServer.close()
  if (tauriProcess && !tauriProcess.killed) {
    if (process.platform === 'win32') {
      tauriProcess.kill()
    } else {
      try {
        process.kill(-tauriProcess.pid, 'SIGTERM')
      } catch {
        tauriProcess.kill()
      }
    }
  }
  setTimeout(() => process.exit(exitCode), 200)
}
