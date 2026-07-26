#!/usr/bin/env node
import { mkdirSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const configPath = resolve(
  process.env.AURORA_TAURI_IOS_THIN_CONFIG_PATH
    ?? join(packageRoot, 'reports', 'generated', 'tauri.ios-thin.conf.json'),
)
const reportPath = resolve(
  process.env.AURORA_TAURI_IOS_THIN_REPORT_PATH
    ?? join(packageRoot, 'reports', 'ios-thin-bundle-prepare.json'),
)
const {
  connectSrc,
  connectionMode,
  gatewayOrigin,
  signalingOrigin,
} = resolveThinPolicy()

const config = {
  build: {
    beforeBuildCommand: 'pnpm build:frontend:ios-thin',
  },
  app: {
    security: {
      capabilities: ['aurora-ios-thin', 'aurora-mobile-mesh'],
      csp: `default-src 'self'; connect-src ${connectSrc.join(' ')}; img-src 'self' data: blob:; media-src 'self' blob: mediastream:; style-src 'self' 'unsafe-inline'; script-src 'self'; worker-src 'self' blob:`,
    },
  },
  bundle: {
    externalBin: [],
    resources: {},
    longDescription:
      'Aurora iOS thin packages the shared WebView HTTP/WebRTC app without Python, sidecar resources, or external binaries. It connects only to exact operator-managed HTTPS/WSS origins compiled into the app.',
  },
}

mkdirSync(dirname(configPath), { recursive: true })
mkdirSync(dirname(reportPath), { recursive: true })
writeAtomicJson(configPath, config)
writeAtomicJson(reportPath, {
  generatedAt: new Date().toISOString(),
  bundleMode: 'ios-thin',
  configPath: redact(configPath),
  connectSrc,
  connectionMode,
  gatewayOrigin,
  signalingOrigin,
  expectedCapabilities: ['aurora-ios-thin', 'aurora-mobile-mesh'],
  pythonSidecarStaged: false,
  externalBin: [],
  resources: {},
  secretsRedacted: true,
})

console.log(`Prepared Python-free iOS-thin Tauri overlay: ${configPath}`)
console.log(`Wrote ${reportPath}`)

function resolveThinPolicy() {
  const configured = (
    process.env.AURORA_TAURI_IOS_ALLOWED_REMOTE_ORIGINS
      ?? process.env.AURORA_TAURI_ALLOWED_REMOTE_ORIGINS
      ?? ''
  ).split(/\s+/).filter(Boolean)
  if (!configured.length) {
    throw new Error(
      'AURORA_TAURI_IOS_ALLOWED_REMOTE_ORIGINS is required for iOS-thin bundles; provide the exact HTTPS Gateway and/or WSS signaling origins required by the selected connection mode.',
    )
  }
  const origins = configured.map((value) => {
    if (/^(https?|wss?):$/.test(value) || value.includes('*')) {
      throw new Error(`iOS-thin remote origins must be exact origins, not broad/wildcard source ${value}`)
    }
    return exactRemoteOrigin(value)
  })
  const gatewayCandidate = origins.find((origin) => origin.startsWith('https://'))
  const signalingCandidate = origins.find((origin) => origin.startsWith('wss://'))
  const connectionMode = resolveConnectionMode(gatewayCandidate, signalingCandidate)
  validateConnectionModeRequirements(connectionMode, gatewayCandidate, signalingCandidate)
  const gatewayOrigin = connectionMode === 'webrtc-only' ? undefined : gatewayCandidate
  const signalingOrigin = connectionMode === 'http-only' ? undefined : signalingCandidate

  const values = new Set(["'self'"])
  if (gatewayOrigin) values.add(gatewayOrigin)
  if (signalingOrigin) values.add(signalingOrigin)
  return {
    connectSrc: [...values],
    connectionMode,
    gatewayOrigin: gatewayOrigin ?? null,
    signalingOrigin: signalingOrigin ?? null,
  }
}

function resolveConnectionMode(gatewayOrigin, signalingOrigin) {
  const configured = process.env.AURORA_TAURI_THIN_CONNECTION_MODE?.trim()
  const inferred = signalingOrigin
    ? (gatewayOrigin ? 'webrtc-preferred' : 'webrtc-only')
    : 'http-only'
  const mode = configured || inferred
  if (!['http-only', 'webrtc-only', 'webrtc-preferred'].includes(mode)) {
    throw new Error(`Invalid iOS-thin connection mode: ${mode}`)
  }
  return mode
}

function validateConnectionModeRequirements(mode, gatewayOrigin, signalingOrigin) {
  if (mode !== 'webrtc-only' && !gatewayOrigin) {
    throw new Error(`${mode} requires an exact HTTPS Gateway origin.`)
  }
  if (mode !== 'http-only' && !signalingOrigin) {
    throw new Error(`${mode} requires an exact WSS signaling origin.`)
  }
}

function exactRemoteOrigin(value) {
  let url
  try {
    url = new URL(value)
  } catch {
    throw new Error(`Invalid URL for iOS-thin CSP origin: ${value}`)
  }
  if (!['https:', 'wss:'].includes(url.protocol)) {
    throw new Error(`iOS-thin remote origins only allow exact https:// or wss:// origins: ${value}`)
  }
  if (url.username || url.password) {
    throw new Error(`iOS-thin remote origins must not include credentials: ${value}`)
  }
  if (url.pathname !== '/') {
    throw new Error(`iOS-thin remote origins must not include non-root paths: ${value}`)
  }
  if (url.search) {
    throw new Error(`iOS-thin remote origins must not include query strings: ${value}`)
  }
  if (url.hash) {
    throw new Error(`iOS-thin remote origins must not include fragments: ${value}`)
  }
  return url.origin
}

function writeAtomicJson(path, value) {
  const temporaryPath = `${path}.tmp`
  writeFileSync(temporaryPath, `${JSON.stringify(value, null, 2)}\n`)
  renameSync(temporaryPath, path)
}

function redact(path) {
  return path.replace(packageRoot, '<package-root>')
}
