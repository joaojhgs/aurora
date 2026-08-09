#!/usr/bin/env node
import { spawn } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { createServer } from 'node:net'
import { basename, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'

const appDir = resolve(import.meta.dirname, '..')
const binariesDir = resolve(appDir, 'src-tauri/binaries')
const reportPath = resolve(appDir, 'reports/sidecar-runtime-smoke.json')
const timeoutMs = Number.parseInt(
  process.env.AURORA_TAURI_SIDECAR_RUNTIME_SMOKE_TIMEOUT_MS ?? '180000',
  10,
)
const binaryPath = resolveSidecarBinary()
const runtimeDir = mkdtempSync(join(tmpdir(), 'aurora-sidecar-runtime-smoke-'))
const port = await reserveLoopbackPort()
const gatewayUrl = `http://127.0.0.1:${port}`
const outputChunks = []
let childExit = null
let spawnError = null

mkdirSync(resolve(appDir, 'reports'), { recursive: true })

const child = spawn(binaryPath, [], {
  cwd: runtimeDir,
  detached: process.platform !== 'win32',
  env: {
    ...process.env,
    AURORA_ARCHITECTURE_MODE: 'threads',
    AURORA_TAURI_MANAGED_SIDECAR: '1',
    AURORA_TAURI_DISABLE_GATEWAY_AUTH: '1',
    AURORA_GATEWAY_URL: gatewayUrl,
    AURORA_GATEWAY_HOST: '127.0.0.1',
    AURORA_GATEWAY_PORT: String(port),
    AURORA_TAURI_SIDECAR_TOKEN: 'runtime-smoke-token',
    AURORA_CONFIG_FILE: join(runtimeDir, 'config.json'),
    AURORA_ENV_FILE: join(runtimeDir, '.env'),
    AURORA_DATA_DIR: join(runtimeDir, 'data'),
  },
  stdio: ['ignore', 'pipe', 'pipe'],
})

child.stdout.on('data', (chunk) => captureOutput('stdout', chunk))
child.stderr.on('data', (chunk) => captureOutput('stderr', chunk))
child.on('error', (error) => {
  spawnError = error
})
child.on('exit', (code, signal) => {
  childExit = { code, signal }
})

let health = null
let failure = null
try {
  health = await waitForHealthyGateway()
  assertHealth(health)
} catch (error) {
  failure = error instanceof Error ? error.message : String(error)
} finally {
  await stopOwnedProcess()
}

if (!childExit && failure === null) {
  failure = 'packaged sidecar did not stop after the smoke health probe'
}

const dataDir = join(runtimeDir, 'data')
const outputTail = redact(outputChunks.join('').slice(-20_000))
const report = {
  schema: 'aurora.tauri.sidecar-runtime-smoke.v1',
  ok: failure === null,
  binary: basename(binaryPath),
  health: health
    ? {
        status: health.status,
        gateway: health.gateway,
        routes: health.routes,
        services: health.services,
      }
    : null,
  persistentState: {
    configFileCreated: existsSync(join(runtimeDir, 'config.json')),
    envFileCreated: existsSync(join(runtimeDir, '.env')),
    dataFileCount: existsSync(dataDir)
      ? readdirSync(dataDir, { withFileTypes: true }).filter((entry) => entry.isFile()).length
      : 0,
  },
  failure,
  childExit,
  outputTail,
  secretsRedacted: true,
}

if (
  report.ok
  && (!report.persistentState.configFileCreated || report.persistentState.dataFileCount < 1)
) {
  report.ok = false
  report.failure = 'packaged sidecar did not create persistent config and data state'
}

if (report.ok && hasMissingLocalEmbeddingsError(outputTail)) {
  report.ok = false
  report.failure = 'packaged sidecar attempted unavailable local embeddings'
}

writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8')
rmSync(runtimeDir, { recursive: true, force: true })
console.log(`[tauri] packaged sidecar runtime smoke report: ${reportPath}`)

if (!report.ok) {
  console.error(`[tauri] packaged sidecar runtime smoke failed: ${report.failure}`)
  process.exitCode = 1
}

function resolveSidecarBinary() {
  const override = process.env.AURORA_TAURI_PACKAGED_SIDECAR_BINARY
  if (override) {
    const resolved = resolve(override)
    if (!existsSync(resolved)) {
      throw new Error('AURORA_TAURI_PACKAGED_SIDECAR_BINARY does not exist')
    }
    return resolved
  }

  const candidates = existsSync(binariesDir)
    ? readdirSync(binariesDir)
        .filter((name) => name.startsWith('aurora-sidecar-'))
        .filter((name) =>
          process.platform === 'win32' ? name.endsWith('.exe') : !name.endsWith('.exe'),
        )
        .map((name) => resolve(binariesDir, name))
    : []
  if (candidates.length !== 1) {
    throw new Error(
      `expected exactly one staged packaged sidecar, found ${candidates.length}`,
    )
  }
  return candidates[0]
}

async function waitForHealthyGateway() {
  const deadline = Date.now() + timeoutMs
  let lastError = 'Gateway did not respond'
  while (Date.now() < deadline) {
    if (spawnError) throw spawnError
    if (childExit) {
      throw new Error(
        `packaged sidecar exited before readiness: code=${String(childExit.code)} signal=${String(childExit.signal)}`,
      )
    }
    try {
      const response = await fetch(`${gatewayUrl}/api/health`, {
        signal: AbortSignal.timeout(2_500),
      })
      if (response.ok) return await response.json()
      lastError = `Gateway returned HTTP ${response.status}`
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error)
    }
    await delay(500)
  }
  throw new Error(`timed out waiting for packaged sidecar health: ${lastError}`)
}

function assertHealth(payload) {
  if (!payload || typeof payload !== 'object') {
    throw new Error('packaged sidecar health payload is not an object')
  }
  if (payload.status !== 'healthy' || payload.gateway !== 'up') {
    throw new Error('packaged sidecar did not report a healthy Gateway')
  }
  if (
    !payload.services
    || payload.services.total < 1
    || payload.services.healthy !== payload.services.total
  ) {
    throw new Error('packaged sidecar services are not all healthy')
  }
  if (!Number.isInteger(payload.routes) || payload.routes < 1) {
    throw new Error('packaged sidecar exposed no Gateway routes')
  }
}

function captureOutput(stream, chunk) {
  const text = redact(chunk.toString('utf8'))
  process[stream === 'stdout' ? 'stdout' : 'stderr'].write(text)
  outputChunks.push(text)
  while (outputChunks.join('').length > 120_000) outputChunks.shift()
}

async function stopOwnedProcess() {
  if (childExit) return
  terminateOwnedTree('SIGINT')
  const deadline = Date.now() + 5_000
  while (!childExit && Date.now() < deadline) await delay(100)
  if (!childExit) {
    terminateOwnedTree('SIGKILL')
    const forceDeadline = Date.now() + 2_000
    while (!childExit && Date.now() < forceDeadline) await delay(100)
  }
}

function terminateOwnedTree(signal) {
  if (childExit) return
  try {
    if (process.platform === 'win32') child.kill(signal)
    else process.kill(-child.pid, signal)
  } catch (error) {
    if (error?.code !== 'ESRCH') {
      outputChunks.push(`[smoke] process cleanup failed: ${String(error)}\n`)
    }
  }
}

function reserveLoopbackPort() {
  return new Promise((resolvePort, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (!address || typeof address === 'string') {
        server.close()
        reject(new Error('could not reserve a loopback port'))
        return
      }
      server.close((error) => {
        if (error) reject(error)
        else resolvePort(address.port)
      })
    })
  })
}

function delay(ms) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms))
}

function redact(text) {
  return text
    .replace(
      /(authorization|api[_-]?key|password|token|secret)(\s*[=:]\s*)[^\s,;]+/gi,
      '$1$2<redacted>',
    )
    .replace(/Bearer\s+[A-Za-z0-9._~+/-]+=*/g, 'Bearer <redacted>')
    .replaceAll(runtimeDir, '<runtime-dir-redacted>')
}

function hasMissingLocalEmbeddingsError(text) {
  return /langchain-huggingface is required for local embeddings/i.test(text)
    || /RAG stores disabled: embeddings unavailable.*langchain-huggingface/i.test(text)
}
