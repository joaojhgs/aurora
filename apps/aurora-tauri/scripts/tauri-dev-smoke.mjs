#!/usr/bin/env node
import { mkdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { spawn } from 'node:child_process'

const appDir = resolve(import.meta.dirname, '..')
const reportPath = resolve(appDir, 'reports/tauri-dev-smoke.json')
const timeoutMs = Number.parseInt(process.env.AURORA_TAURI_DEV_SMOKE_TIMEOUT_MS ?? '180000', 10)
const gatewayUrl = new URL(process.env.AURORA_TAURI_DEV_SMOKE_GATEWAY_URL ?? 'http://127.0.0.1:8000')
const command = process.env.AURORA_TAURI_DEV_SMOKE_COMMAND ?? 'pnpm'
const args = splitArgs(process.env.AURORA_TAURI_DEV_SMOKE_ARGS ?? '--filter @aurora/tauri-ui tauri dev')
const requiredLogMarkers = (process.env.AURORA_TAURI_DEV_SMOKE_REQUIRE_LOGS ?? '[tauri],[aurora][')
  .split(',')
  .map((marker) => marker.trim())
  .filter(Boolean)
const requiredGatewayPaths = ['/api/health', '/api/registry', '/api/services']
const logState = Object.fromEntries(requiredLogMarkers.map((marker) => [marker, false]))
const gatewayState = Object.fromEntries(requiredGatewayPaths.map((path) => [path, false]))
const outputChunks = []
let finished = false
let lastGatewayError = null

mkdirSync(resolve(appDir, 'reports'), { recursive: true })
console.log(`[gateway] dev smoke probing ${gatewayUrl.origin}`)
console.log(`[tauri] dev smoke launching: ${command} ${args.join(' ')}`)

const child = spawn(command, args, {
  cwd: resolve(appDir, '../..'),
  env: {
    ...process.env,
    AURORA_TAURI_DEV_AUTOSIDECAR: process.env.AURORA_TAURI_DEV_AUTOSIDECAR ?? '1'
  },
  stdio: ['ignore', 'pipe', 'pipe']
})

child.stdout.on('data', (chunk) => captureLog('stdout', chunk))
child.stderr.on('data', (chunk) => captureLog('stderr', chunk))
child.on('error', (error) => finish(1, `failed to launch tauri dev: ${error.message}`))
child.on('exit', (code, signal) => {
  if (!finished) {
    finish(1, `tauri dev exited before Gateway/log readiness: code=${String(code)} signal=${String(signal)}`)
  }
})

const timeout = setTimeout(() => {
  finish(1, `timed out waiting for Gateway/log readiness after ${timeoutMs}ms`)
}, timeoutMs)

const interval = setInterval(() => {
  void checkReadiness()
}, 1500)
void checkReadiness()

function captureLog(stream, chunk) {
  const text = chunk.toString('utf8')
  process[stream === 'stdout' ? 'stdout' : 'stderr'].write(text)
  outputChunks.push(text)
  while (outputChunks.join('').length > 120_000) outputChunks.shift()
  for (const marker of requiredLogMarkers) {
    if (text.includes(marker)) logState[marker] = true
  }
}

async function checkReadiness() {
  await Promise.all(requiredGatewayPaths.map(async (path) => {
    if (gatewayState[path]) return
    try {
      const response = await fetch(new URL(path, gatewayUrl), { signal: AbortSignal.timeout(2_500) })
      if (response.ok) {
        gatewayState[path] = true
        console.log(`[gateway] ${path} ready (${response.status})`)
      } else {
        lastGatewayError = `${path} returned HTTP ${response.status}`
      }
    } catch (error) {
      lastGatewayError = `${path}: ${error instanceof Error ? error.message : String(error)}`
    }
  }))

  if (Object.values(gatewayState).every(Boolean) && Object.values(logState).every(Boolean)) {
    finish(0, 'tauri dev Gateway readiness and log markers observed')
  }
}

function finish(exitCode, reason) {
  if (finished) return
  finished = true
  clearTimeout(timeout)
  clearInterval(interval)
  const report = {
    ok: exitCode === 0,
    reason,
    command,
    args,
    gatewayUrl: gatewayUrl.origin,
    gatewayState,
    requiredLogMarkers,
    logState,
    lastGatewayError,
    outputTail: redact(outputChunks.join('').slice(-20_000))
  }
  writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`)
  console.log(`[tauri] dev smoke report: ${reportPath}`)
  process.exitCode = exitCode
  if (!child.killed) child.kill('SIGINT')
  setTimeout(() => process.exit(exitCode), 500)
}

function splitArgs(value) {
  return value.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g)?.map((part) => part.replace(/^['"]|['"]$/g, '')) ?? []
}

function redact(text) {
  return text
    .replace(/(authorization|api[_-]?key|token|secret)([=:\s]+)[^\s,;]+/gi, '$1$2<redacted>')
    .replace(/Bearer\s+[A-Za-z0-9._~+/-]+=*/g, 'Bearer <redacted>')
}
