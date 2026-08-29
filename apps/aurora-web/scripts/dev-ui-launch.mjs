#!/usr/bin/env node
/**
 * Shared Next debug server + isolated preset wrappers.
 *
 * Default polish loop (one process):
 *   pnpm dev:ui:debug
 *   http://127.0.0.1:3000/?aurora-surface=android&aurora-role=mesh-node&aurora-admin=0
 *
 * Surface/role/admin are a runtime override (query + cookie + sessionStorage).
 * Do not bake a compile-time runtime-mode env or a unique NEXT_PUBLIC_* role into
 * production APK/desktop bundles, and do not compile a distinct Next preset
 * per surface. Isolated `dev:ui:<preset>` processes still get a random port
 * for process isolation, then apply the same query string.
 *
 * Point a preset at an already-running debug server:
 *   AURORA_UI_DEBUG_URL=http://127.0.0.1:3000 pnpm dev:ui:android-node
 */
import { createServer } from 'node:net'
import { spawn } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { auroraVersionLabel } from '../../../scripts/aurora-version.mjs'

const PRESETS = {
  'web-remote': {
    surface: 'web',
    role: 'remote-console',
    admin: '0',
    label: 'Hosted web · remote console',
  },
  'web-remote-admin': {
    surface: 'web',
    role: 'remote-console',
    admin: '1',
    label: 'Hosted web · remote console admin',
  },
  'web-node': {
    surface: 'web',
    role: 'mesh-node',
    admin: '0',
    label: 'Hosted web · mesh node',
  },
  'desktop-local': {
    surface: 'desktop-local',
    role: 'mesh-node',
    tier: 'python-full',
    admin: '0',
    label: 'Desktop native · local node',
  },
  'desktop-thin-remote': {
    surface: 'desktop-thin',
    role: 'remote-console',
    admin: '0',
    label: 'Desktop thin · management UI',
  },
  'desktop-node': {
    surface: 'desktop-thin',
    role: 'mesh-node',
    admin: '0',
    label: 'Desktop client · mesh node',
  },
  'android-remote': {
    surface: 'android',
    role: 'remote-console',
    admin: '0',
    label: 'Android · remote console',
  },
  'android-node': {
    surface: 'android',
    role: 'mesh-node',
    admin: '0',
    label: 'Android · mesh node',
  },
  'ios-remote': {
    surface: 'ios',
    role: 'remote-console',
    admin: '0',
    label: 'iOS · remote console',
  },
  'ios-node': {
    surface: 'ios',
    role: 'mesh-node',
    admin: '0',
    label: 'iOS · mesh node',
  },
  'mobile-node': {
    surface: 'mobile',
    role: 'mesh-node',
    admin: '0',
    label: 'Mobile WebView · mesh node',
  },
}

const DEFAULT_DEBUG_HOST = '127.0.0.1'
const DEFAULT_DEBUG_PORT = 3000

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const presetId = (process.argv[2] ?? '').trim()
const isolated = process.argv.includes('--isolated') || truthy(process.env.AURORA_UI_LAUNCH_ISOLATED)

if (!presetId || (presetId !== 'debug' && !(presetId in PRESETS))) {
  const names = ['debug', ...Object.keys(PRESETS)].join('\n  ')
  console.error(`Usage: node scripts/dev-ui-launch.mjs <preset> [--isolated]\n\nPresets:\n  ${names}`)
  process.exit(1)
}

const auroraVersion =
  process.env.NEXT_PUBLIC_AURORA_VERSION_LABEL?.trim() || auroraVersionLabel({ dev: true })

if (presetId === 'debug') {
  await startSharedDebugServer(auroraVersion)
} else {
  await startOrAttachPreset(presetId, auroraVersion, isolated)
}

async function startSharedDebugServer(version) {
  const host = process.env.HOST?.trim() || DEFAULT_DEBUG_HOST
  const port = Number(process.env.PORT) || DEFAULT_DEBUG_PORT
  const url = `http://${host}:${port}`
  const inUse = await portInUse(host, port)
  if (inUse) {
    console.log(`[aurora-ui-launch] Shared debug server already running at ${url}`)
    printQueryContract(url)
    return
  }
  console.log('[aurora-ui-launch] preset=debug')
  console.log('[aurora-ui-launch] Shared debug server · runtime surface/role override')
  printQueryContract(url)
  await spawnNext({ host, port, version, distDir: process.env.NEXT_DIST_DIR || '.next' })
}

async function startOrAttachPreset(id, version, forceIsolated) {
  const preset = PRESETS[id]
  const query = queryForPreset(preset)
  const attachUrl = process.env.AURORA_UI_DEBUG_URL?.trim()
  if (attachUrl && !forceIsolated) {
    const url = withQuery(attachUrl, query)
    console.log(`[aurora-ui-launch] preset=${id}`)
    console.log(`[aurora-ui-launch] ${preset.label}`)
    console.log('[aurora-ui-launch] Attaching to shared debug server (no new Next process)')
    console.log(`[aurora-ui-launch] ${url}`)
    return
  }

  const host = DEFAULT_DEBUG_HOST
  const port = await reserveFreePort()
  const url = withQuery(`http://${host}:${port}`, query)
  console.log(`[aurora-ui-launch] preset=${id}`)
  console.log(`[aurora-ui-launch] ${preset.label}`)
  console.log(`[aurora-ui-launch] Isolated Next process · runtime override via query string`)
  console.log(`[aurora-ui-launch] ${url}`)
  console.log(`[aurora-ui-launch] Prefer one shared server: pnpm dev:ui:debug then open the query URL`)
  await spawnNext({
    host,
    port,
    version,
    distDir: process.env.NEXT_DIST_DIR || `tmp/aurora-ui-next/${id}`,
  })
}

function queryForPreset(preset) {
  const params = [
    `aurora-surface=${preset.surface}`,
    `aurora-role=${preset.role}`,
    `aurora-admin=${preset.admin}`,
  ]
  if (preset.tier) params.splice(2, 0, `aurora-tier=${preset.tier}`)
  return params.join('&')
}

function withQuery(baseUrl, query) {
  const url = new URL(baseUrl)
  const incoming = new URLSearchParams(query)
  for (const [key, value] of incoming) url.searchParams.set(key, value)
  return url.toString()
}

function printQueryContract(url) {
  console.log(`[aurora-ui-launch] ${url}`)
  console.log('[aurora-ui-launch] Query contract (runtime override, not compile-time env):')
  console.log('[aurora-ui-launch]   aurora-surface=web|desktop-local|desktop-thin|android|ios')
  console.log('[aurora-ui-launch]   aurora-role=remote-console|mesh-node')
  console.log('[aurora-ui-launch]   aurora-tier=none|lightweight-ts|python-full')
  console.log('[aurora-ui-launch]   aurora-admin=0|1')
  console.log('[aurora-ui-launch]   aurora-viewport=phone|tablet|full')
  console.log(`[aurora-ui-launch] Example: ${url}/?aurora-surface=android&aurora-role=mesh-node&aurora-admin=0&aurora-viewport=phone`)
  console.log(`[aurora-ui-launch] Active override JSON: ${url}/__aurora/debug-preset`)
}

async function spawnNext({ host, port, version, distDir }) {
  const env = {
    ...process.env,
    HOST: host,
    PORT: String(port),
    NEXT_DIST_DIR: distDir,
    NEXT_PUBLIC_AURORA_DEBUG_UI: '1',
    NEXT_PUBLIC_AURORA_WEB_DEMO_MODE: process.env.NEXT_PUBLIC_AURORA_WEB_DEMO_MODE ?? '1',
    AURORA_WEB_DEMO_MODE: process.env.AURORA_WEB_DEMO_MODE ?? '1',
    NEXT_PUBLIC_AURORA_WEBRTC_ALLOW_INSECURE_LOOPBACK:
      process.env.NEXT_PUBLIC_AURORA_WEBRTC_ALLOW_INSECURE_LOOPBACK ?? '1',
    NEXT_PUBLIC_AURORA_VERSION_LABEL: version,
  }
  delete env.NEXT_PUBLIC_AURORA_DEBUG_UI_PRESET

  const child = spawn(
    process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm',
    ['exec', 'next', 'dev', '--hostname', host, '--port', String(port)],
    {
      cwd: appRoot,
      env,
      stdio: 'inherit',
    },
  )

  child.on('exit', (code, signal) => {
    if (signal) {
      process.kill(process.pid, signal)
      return
    }
    process.exit(code ?? 1)
  })

  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => {
      if (!child.killed) child.kill(signal)
    })
  }
}

function reserveFreePort() {
  return new Promise((resolvePort, reject) => {
    const server = createServer()
    server.listen(0, DEFAULT_DEBUG_HOST, () => {
      const address = server.address()
      if (!address || typeof address === 'string') {
        server.close(() => reject(new Error('Failed to reserve a free port')))
        return
      }
      const nextPort = address.port
      server.close((error) => {
        if (error) reject(error)
        else resolvePort(nextPort)
      })
    })
    server.on('error', reject)
  })
}

function portInUse(host, port) {
  return new Promise((resolveInUse) => {
    const server = createServer()
    server.once('error', (error) => {
      resolveInUse(error && error.code === 'EADDRINUSE')
    })
    server.listen(port, host, () => {
      server.close(() => resolveInUse(false))
    })
  })
}

function truthy(value) {
  if (!value) return false
  const normalized = value.trim().toLowerCase()
  return normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'on'
}
