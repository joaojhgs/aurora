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
const connectSrc = ["'self'", 'http:', 'https:', 'ws:', 'wss:']

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
      'Aurora iOS thin packages the shared WebView HTTP/WebRTC app without Python, sidecar resources, or external binaries. Gateway and signaling endpoints are configured at runtime during onboarding and are not compiled into the artifact.',
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
  connectionMode: 'runtime-configurable',
  gatewayOrigin: null,
  signalingOrigin: null,
  runtimeConfiguredEndpoints: true,
  expectedCapabilities: ['aurora-ios-thin', 'aurora-mobile-mesh'],
  pythonSidecarStaged: false,
  externalBin: [],
  resources: {},
  secretsRedacted: true,
})

console.log(`Prepared Python-free iOS-thin Tauri overlay: ${configPath}`)
console.log(`Wrote ${reportPath}`)

function writeAtomicJson(path, value) {
  const temporaryPath = `${path}.tmp`
  writeFileSync(temporaryPath, `${JSON.stringify(value, null, 2)}\n`)
  renameSync(temporaryPath, path)
}

function redact(path) {
  return path.replace(packageRoot, '<package-root>')
}
