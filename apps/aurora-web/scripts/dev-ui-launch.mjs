#!/usr/bin/env node
import { createServer } from 'node:net'
import { spawn } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const PRESETS = {
  'web-remote': {
    runtimeMode: 'web-thin',
    nodeMode: 'remote-console',
    label: 'Hosted web · remote console',
  },
  'web-node': {
    runtimeMode: 'web-thin',
    nodeMode: 'mesh-node',
    label: 'Hosted web · mesh node',
  },
  'desktop-local': {
    runtimeMode: 'desktop-local',
    nodeMode: 'mesh-node',
    label: 'Desktop native · local node',
  },
  'desktop-thin-remote': {
    runtimeMode: 'desktop-thin',
    nodeMode: 'remote-console',
    label: 'Desktop thin · management UI',
  },
  'desktop-node': {
    runtimeMode: 'desktop-thin',
    nodeMode: 'mesh-node',
    label: 'Desktop client · mesh node',
  },
  'android-remote': {
    runtimeMode: 'android',
    nodeMode: 'remote-console',
    label: 'Android · remote console',
  },
  'android-node': {
    runtimeMode: 'android-node',
    nodeMode: 'mesh-node',
    label: 'Android · mesh node',
  },
  'ios-remote': {
    runtimeMode: 'ios',
    nodeMode: 'remote-console',
    label: 'iOS · remote console',
  },
  'ios-node': {
    runtimeMode: 'ios',
    nodeMode: 'mesh-node',
    label: 'iOS · mesh node',
  },
  'mobile-node': {
    runtimeMode: 'mobile',
    nodeMode: 'mesh-node',
    label: 'Mobile WebView · mesh node',
  },
}

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const presetId = (process.argv[2] ?? '').trim()

if (!presetId || !(presetId in PRESETS)) {
  const names = Object.keys(PRESETS).join('\n  ')
  console.error(`Usage: node scripts/dev-ui-launch.mjs <preset>\n\nPresets:\n  ${names}`)
  process.exit(1)
}

const preset = PRESETS[presetId]
const host = '127.0.0.1'
const port = await reserveFreePort()
const url = `http://${host}:${port}`

const env = {
  ...process.env,
  PORT: String(port),
  NEXT_PUBLIC_AURORA_DEBUG_UI: '1',
  NEXT_PUBLIC_AURORA_DEBUG_UI_PRESET: presetId,
  NEXT_PUBLIC_AURORA_WEB_DEMO_MODE: process.env.NEXT_PUBLIC_AURORA_WEB_DEMO_MODE ?? '1',
  AURORA_WEB_DEMO_MODE: process.env.AURORA_WEB_DEMO_MODE ?? '1',
  NEXT_PUBLIC_AURORA_WEBRTC_ALLOW_INSECURE_LOOPBACK:
    process.env.NEXT_PUBLIC_AURORA_WEBRTC_ALLOW_INSECURE_LOOPBACK ?? '1',
}

console.log(`[aurora-ui-launch] preset=${presetId}`)
console.log(`[aurora-ui-launch] ${preset.label}`)
console.log(`[aurora-ui-launch] surface=${preset.runtimeMode} nodeMode=${preset.nodeMode}`)
console.log(`[aurora-ui-launch] ${url}`)

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

function reserveFreePort() {
  return new Promise((resolvePort, reject) => {
    const server = createServer()
    server.listen(0, host, () => {
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
