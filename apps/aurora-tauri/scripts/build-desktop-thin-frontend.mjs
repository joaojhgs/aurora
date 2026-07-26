import { spawnSync } from 'node:child_process'

const origins = (process.env.AURORA_TAURI_ALLOWED_REMOTE_ORIGINS ?? '')
  .split(/\s+/)
  .filter(Boolean)
  .map((value) => exactRemoteUrl(value))

const gatewayCandidate = origins.find((url) => url.protocol === 'https:')
const signalingCandidate = origins.find((url) => url.protocol === 'wss:')

const connectionMode =
  process.env.AURORA_TAURI_THIN_CONNECTION_MODE
  ?? (signalingCandidate ? (gatewayCandidate ? 'webrtc-preferred' : 'webrtc-only') : 'http-only')
if (!['http-only', 'webrtc-only', 'webrtc-preferred'].includes(connectionMode)) {
  throw new Error(`Invalid desktop-thin connection mode: ${connectionMode}`)
}
if (connectionMode !== 'webrtc-only' && !gatewayCandidate) {
  throw new Error(`${connectionMode} requires an exact HTTPS Gateway origin.`)
}
if (connectionMode !== 'http-only' && !signalingCandidate) {
  throw new Error(`${connectionMode} requires an exact WSS signaling origin.`)
}
const gateway = connectionMode === 'webrtc-only' ? undefined : gatewayCandidate
const signaling = connectionMode === 'http-only' ? undefined : signalingCandidate

const env = {
  ...process.env,
  VITE_AURORA_RUNTIME_MODE: 'desktop-thin',
  VITE_AURORA_GATEWAY_URL: gateway?.origin ?? '',
  VITE_AURORA_SIGNALING_URL: signaling?.origin ?? '',
  VITE_AURORA_CONNECTION_MODE: connectionMode,
}

const result = spawnSync('pnpm', ['build'], {
  cwd: new URL('..', import.meta.url),
  env,
  stdio: 'inherit',
  shell: process.platform === 'win32',
})

if (result.error) throw result.error
if (result.status !== 0) {
  throw new Error(`Desktop-thin frontend build failed with status ${result.status}`)
}

function exactRemoteUrl(value) {
  if (/^(https?|wss?):$/.test(value) || value.includes('*')) {
    throw new Error(`Desktop-thin frontend remote origins must be exact origins, not broad/wildcard source ${value}`)
  }
  let url
  try {
    url = new URL(value)
  } catch {
    throw new Error(`Invalid desktop-thin frontend remote origin: ${value}`)
  }
  if (!['https:', 'wss:'].includes(url.protocol)) {
    throw new Error(`Desktop-thin frontend remote origins only allow exact https:// or wss:// origins: ${value}`)
  }
  if (url.username || url.password) {
    throw new Error(`Desktop-thin frontend remote origins must not include credentials: ${value}`)
  }
  if (url.pathname !== '/') {
    throw new Error(`Desktop-thin frontend remote origins must not include non-root paths: ${value}`)
  }
  if (url.search) {
    throw new Error(`Desktop-thin frontend remote origins must not include query strings: ${value}`)
  }
  if (url.hash) {
    throw new Error(`Desktop-thin frontend remote origins must not include fragments: ${value}`)
  }
  return url
}
