import { spawnSync } from 'node:child_process'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const packageRoot = fileURLToPath(new URL('..', import.meta.url))
const outputRoot = join(packageRoot, 'dist')
const liveHookEnabled = process.env.VITE_AURORA_DESKTOP_LIVE_E2E === '1'

const env = {
  ...process.env,
  VITE_AURORA_GATEWAY_URL: '',
  VITE_AURORA_SIGNALING_URL: '',
  VITE_AURORA_CONNECTION_MODE: liveHookEnabled ? 'webrtc-only' : '',
  VITE_AURORA_WEBRTC_ALLOW_INSECURE_LOOPBACK: liveHookEnabled ? '1' : '',
  ...(liveHookEnabled
    ? {
        VITE_AURORA_RUNTIME_MODE: 'desktop-thin',
      }
    : {}),
}

const result = spawnSync('pnpm', ['build'], {
  cwd: packageRoot,
  env,
  stdio: 'inherit',
  shell: process.platform === 'win32',
})

if (result.error) throw result.error
if (result.status !== 0) {
  throw new Error(`Desktop client frontend build failed with status ${result.status}`)
}

const outputText = readTextOutput(outputRoot)
const hookMarkers = [
  '__AURORA_DESKTOP_LIVE_E2E__',
  'aurora.desktop_live_e2e.hook_payload.v1',
]
const observedMarkers = hookMarkers.filter((marker) => outputText.includes(marker))
if (liveHookEnabled && observedMarkers.length !== hookMarkers.length) {
  throw new Error('Desktop live E2E build is missing the gated WebView hook')
}
if (!liveHookEnabled && observedMarkers.length !== 0) {
  throw new Error('Production desktop client frontend contains desktop live E2E hook markers')
}

console.log(
  liveHookEnabled
    ? 'Desktop live E2E hook boundary passed: gated hook included'
    : 'Desktop live E2E hook boundary passed: production output excludes the hook',
)

function readTextOutput(root) {
  const files = []
  const pending = [root]
  while (pending.length > 0) {
    const current = pending.pop()
    for (const name of readdirSync(current)) {
      const entry = join(current, name)
      const stat = statSync(entry)
      if (stat.isDirectory()) {
        pending.push(entry)
      } else if (stat.isFile() && stat.size <= 5_000_000) {
        files.push(entry)
      }
    }
  }
  return files.map((file) => readFileSync(file, 'utf8')).join('\n')
}
