#!/usr/bin/env node
import { mkdirSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const srcTauriRoot = join(packageRoot, 'src-tauri')
const configPath = resolve(process.env.AURORA_TAURI_ANDROID_THIN_CONFIG_PATH ?? join(srcTauriRoot, 'tauri.android-thin.conf.json'))
const reportPath = resolve(process.env.AURORA_TAURI_ANDROID_THIN_REPORT_PATH ?? join(packageRoot, 'reports', 'android-thin-bundle-prepare.json'))
const reportDir = dirname(reportPath)

const connectSrc = ["'self'", 'http:', 'https:', 'ws:', 'wss:']

const config = {
  build: {
    beforeBuildCommand: 'pnpm build:frontend:android-thin'
  },
  app: {
    security: {
      capabilities: ['aurora-android-thin', 'aurora-mobile-mesh'],
      csp: `default-src 'self'; connect-src ${connectSrc.join(' ')}; img-src 'self' data: blob:; media-src 'self' blob: mediastream:; style-src 'self' 'unsafe-inline'; script-src 'self'; worker-src 'self' blob:`
    }
  },
  bundle: {
    externalBin: [],
    resources: {},
    longDescription:
      'Aurora Android thin packages the shared WebView HTTP/WebRTC app without Python, sidecar resources, or external binaries. Gateway and signaling endpoints are configured at runtime during onboarding and are not compiled into the artifact.'
  }
}

mkdirSync(dirname(configPath), { recursive: true })
mkdirSync(reportDir, { recursive: true })
writeAtomicJson(configPath, config)
writeAtomicJson(reportPath, {
  generatedAt: new Date().toISOString(),
  bundleMode: 'android-thin',
  configPath: redact(configPath),
  connectSrc,
  connectionMode: 'runtime-configurable',
  gatewayOrigin: null,
  signalingOrigin: null,
  runtimeConfiguredEndpoints: true,
  expectedCapabilities: ['aurora-android-thin', 'aurora-mobile-mesh'],
  pythonSidecarStaged: false,
  externalBin: [],
  resources: {},
  secretsRedacted: true
})

console.log(`Prepared Python-free Android-thin Tauri overlay: ${configPath}`)
console.log(`Wrote ${reportPath}`)

function writeAtomicJson(path, value) {
  const tmp = `${path}.tmp`
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`)
  renameSync(tmp, path)
}

function redact(path) {
  return path.replace(packageRoot, '<package-root>')
}
