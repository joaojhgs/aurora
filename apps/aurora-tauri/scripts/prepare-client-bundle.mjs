import { mkdirSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const srcTauriRoot = join(packageRoot, 'src-tauri')
const configPath = resolve(
  process.env.AURORA_TAURI_CLIENT_CONFIG_PATH
    ?? process.env.AURORA_TAURI_THIN_CONFIG_PATH
    ?? join(srcTauriRoot, 'tauri.client.conf.json'),
)
const reportPath = resolve(
  process.env.AURORA_TAURI_CLIENT_REPORT_PATH
    ?? process.env.AURORA_TAURI_THIN_REPORT_PATH
    ?? join(packageRoot, 'reports', 'desktop-client-bundle-prepare.json'),
)
const reportDir = dirname(reportPath)

const connectSrc = ["'self'", 'http://ipc.localhost', 'http://127.0.0.1:*', 'http://localhost:*', 'ws://127.0.0.1:*', 'ws://localhost:*', 'https:', 'wss:']

const config = {
  build: {
    beforeBuildCommand: 'pnpm build:frontend:desktop-client'
  },
  app: {
    security: {
      capabilities: ['aurora-thin'],
      csp: `default-src 'self'; connect-src ${connectSrc.join(' ')}; img-src 'self' data: blob:; media-src 'self' blob: mediastream:; style-src 'self' 'unsafe-inline'; script-src 'self'; worker-src 'self' blob:`
    }
  },
  bundle: {
    externalBin: [],
    resources: {},
    longDescription:
      'Aurora desktop client packages the official Tauri 2 shell without Python service resources. Gateway and signaling endpoints are configured at runtime during onboarding and are not compiled into the artifact.'
  }
}

mkdirSync(dirname(configPath), { recursive: true })
mkdirSync(reportDir, { recursive: true })
writeAtomicJson(configPath, config)
writeAtomicJson(reportPath, {
  generatedAt: new Date().toISOString(),
  bundleMode: 'desktop-client',
  configPath: redact(configPath),
  connectSrc,
  connectionMode: 'runtime-configurable',
  gatewayOrigin: null,
  signalingOrigin: null,
  runtimeConfiguredEndpoints: true,
  pythonSidecarStaged: false,
  secretsRedacted: true
})

console.log(`Prepared Python-free desktop client Tauri overlay: ${configPath}`)
console.log(`Wrote ${reportPath}`)

function writeAtomicJson(path, value) {
  const tmp = `${path}.tmp`
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`)
  renameSync(tmp, path)
}

function redact(path) {
  return path.replace(packageRoot, '<package-root>')
}
