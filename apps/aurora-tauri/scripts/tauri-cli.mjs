#!/usr/bin/env node
import { existsSync } from 'node:fs'
import { spawn, spawnSync } from 'node:child_process'
import { delimiter, dirname, join, resolve } from 'node:path'
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
if (args[0] === 'android') Object.assign(env, resolveAndroidJava(env))
if (args[0] === 'dev') {
  if (env.AURORA_TAURI_DEV_AUTOSIDECAR !== '0') applyDevSidecarDefaults(env)
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
  if (env.AURORA_TAURI_DEV_AUTOSIDECAR === '0') {
    console.log('[tauri] desktop client: enabled (Vite + Tauri shell, no Rust-supervised Python sidecar)')
    console.log('[tauri] endpoints: runtime-configured by onboarding/profile storage')
    return
  }
  console.log('[tauri] real local stack: enabled (Vite + Tauri + Rust-supervised Python sidecar)')
  console.log(`[tauri] sidecar program: ${env.AURORA_TAURI_SIDECAR_PROGRAM}`)
  console.log(`[tauri] sidecar args: ${env.AURORA_TAURI_SIDECAR_ARGS}`)
  console.log(`[tauri] sidecar cwd: ${env.AURORA_TAURI_SIDECAR_CWD}`)
  console.log(`[tauri] architecture mode: ${env.AURORA_ARCHITECTURE_MODE}`)
  console.log(`[tauri] gateway: ${env.AURORA_GATEWAY_URL}`)
}

function resolveAndroidJava(env) {
  if (env.JAVA_HOME && existsSync(join(env.JAVA_HOME, 'bin', javaExecutable()))) return env
  if (javaCommandWorks(env)) return env

  const version = asdfJavaVersions(env)[0]
  if (!version) return env
  const home = asdfJavaHome(version, env)
  if (!home || !existsSync(join(home, 'bin', javaExecutable()))) return env

  return {
    ...env,
    ASDF_JAVA_VERSION: version,
    JAVA_HOME: home,
    PATH: `${join(home, 'bin')}${delimiter}${env.PATH ?? ''}`,
  }
}

function javaExecutable() {
  return process.platform === 'win32' ? 'java.exe' : 'java'
}

function javaCommandWorks(env) {
  const result = spawnSync('java', ['-version'], {
    cwd: appDir,
    env,
    encoding: 'utf8',
    shell: process.platform === 'win32',
  })
  return result.status === 0
}

function asdfJavaVersions(env) {
  const result = spawnSync('asdf', ['list', 'java'], {
    cwd: appDir,
    env,
    encoding: 'utf8',
    shell: process.platform === 'win32',
  })
  if (result.status !== 0) return []
  return result.stdout
    .split('\n')
    .map((line) => line.trim().replace(/^\*\s*/, ''))
    .filter(Boolean)
    .sort((left, right) => javaVersionRank(right) - javaVersionRank(left))
}

function asdfJavaHome(version, env) {
  const result = spawnSync('asdf', ['where', 'java', version], {
    cwd: appDir,
    env,
    encoding: 'utf8',
    shell: process.platform === 'win32',
  })
  return result.status === 0 ? result.stdout.trim() : null
}

function javaVersionRank(version) {
  const match = version.match(/(?:^|[-_])(\d+)(?:[._-]|$)/)
  if (!match) return 0
  const major = Number(match[1])
  return Number.isFinite(major) ? major : 0
}
