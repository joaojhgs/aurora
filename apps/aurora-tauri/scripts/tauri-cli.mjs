#!/usr/bin/env node
import { existsSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const scriptDir = dirname(fileURLToPath(import.meta.url))
const appDir = resolve(scriptDir, '..')
const repoDir = resolve(appDir, '..', '..')
const tauriCli = resolve(appDir, 'node_modules', '@tauri-apps', 'cli', 'tauri.js')
const args = process.argv.slice(2)

if (!existsSync(tauriCli)) {
  console.error(`[tauri] Tauri CLI not found at ${tauriCli}. Run pnpm install from the repo root.`)
  process.exit(1)
}

const env = { ...process.env }
if (args[0] === 'dev') {
  applyDevSidecarDefaults(env)
  printDevBanner(env)
}

const child = spawn(process.execPath, [tauriCli, ...args], {
  cwd: appDir,
  env,
  stdio: 'inherit'
})

let shuttingDown = false
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => forwardShutdownSignal(signal))
}

child.on('exit', (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal)
    return
  }
  process.exit(code ?? 1)
})

child.on('error', (error) => {
  console.error(`[tauri] Failed to launch Tauri CLI: ${error.message}`)
  process.exit(1)
})

function forwardShutdownSignal(signal) {
  if (shuttingDown) return
  shuttingDown = true
  console.error(`[tauri] received ${signal}; forwarding shutdown to Tauri child process`)
  if (!child.killed) child.kill(signal)
  const exitCode = signal === 'SIGINT' ? 130 : 143
  const timer = setTimeout(() => process.exit(exitCode), 5000)
  child.once('exit', () => {
    clearTimeout(timer)
    process.exit(exitCode)
  })
}

function applyDevSidecarDefaults(env) {
  env.AURORA_ARCHITECTURE_MODE ??= 'threads'
  env.AURORA_TAURI_DEV_AUTOSIDECAR ??= '1'
  env.AURORA_TAURI_SIDECAR_CWD ??= repoDir
  env.AURORA_GATEWAY_URL ??= 'http://127.0.0.1:8000'

  if (!env.AURORA_TAURI_SIDECAR_PROGRAM) {
    const venvPython = resolve(repoDir, '.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python')
    if (existsSync(venvPython)) {
      env.AURORA_TAURI_SIDECAR_PROGRAM = venvPython
      env.AURORA_TAURI_SIDECAR_ARGS ??= 'main.py'
    } else {
      env.AURORA_TAURI_SIDECAR_PROGRAM = 'uv'
      env.AURORA_TAURI_SIDECAR_ARGS ??= 'run --no-dev --extra sidecar-thin python main.py'
    }
  } else {
    env.AURORA_TAURI_SIDECAR_ARGS ??= 'main.py'
  }
}

function printDevBanner(env) {
  console.log('[tauri] dev bootstrap')
  console.log('[tauri] real local stack: enabled (Vite + Tauri + Rust-supervised Python sidecar)')
  console.log(`[tauri] sidecar program: ${env.AURORA_TAURI_SIDECAR_PROGRAM}`)
  console.log(`[tauri] sidecar args: ${env.AURORA_TAURI_SIDECAR_ARGS}`)
  console.log(`[tauri] sidecar cwd: ${env.AURORA_TAURI_SIDECAR_CWD}`)
  console.log(`[tauri] architecture mode: ${env.AURORA_ARCHITECTURE_MODE}`)
  console.log(`[tauri] gateway: ${env.AURORA_GATEWAY_URL}`)
}
