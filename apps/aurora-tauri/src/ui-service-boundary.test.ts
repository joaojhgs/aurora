import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')

const scannedRoots = [
  'apps/aurora-tauri/src',
  'apps/aurora-tauri/src-tauri/src',
  'apps/aurora-tauri/scripts',
  'apps/aurora-web/app',
  'packages/aurora-ui/src',
  'packages/aurora-sdk/src'
]

const sourcePattern = /\.(ts|tsx|js|mjs|rs)$/
const testPattern = /\.(test|spec)\.(ts|tsx|js|mjs)$/

const excludedFiles = new Set([
  // Fixtures may contain backend provenance strings such as source_file paths, but they are
  // not live service bindings and should stay clearly outside production route truth.
  'packages/aurora-sdk/src/fixtures.ts'
])

const allowedSidecarServiceResource = 'app/services/config/config_defaults.json'

const forbiddenBoundaryPatterns: Array<{ label: string; pattern: RegExp }> = [
  {
    label: 'Python service package import',
    pattern: /\b(?:from|import)\s+['"]?app[./](?:services|messaging|shared[./](?:contracts|services|config))/
  },
  {
    label: 'direct Aurora bus or service runtime object',
    pattern: /\b(?:LocalBus|BullMQBus|MeshBus|ConfigManager|BaseService|method_contract|get_bus)\b/
  },
  {
    label: 'Python service implementation file path',
    pattern: /app\/services\/(?!config\/config_defaults\.json\b)[A-Za-z0-9_./-]+\.py\b/
  },
  {
    label: 'direct Python app package path outside sidecar config default',
    pattern: /app\/(?:messaging|shared\/contracts|shared\/services)\b/
  }
]

function filesUnder(dir: string): string[] {
  if (!existsSync(dir)) return []
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) return filesUnder(path)
    return sourcePattern.test(entry.name) && !testPattern.test(entry.name) ? [path] : []
  })
}

function readRepo(path: string) {
  return readFileSync(resolve(repoRoot, path), 'utf8')
}

function scrubAllowedServiceResource(text: string) {
  return text.split(allowedSidecarServiceResource).join('')
}

describe('UI and Tauri service boundary contract', () => {
  it('keeps production UI, SDK, and Tauri code behind SDK/Gateway/Tauri boundaries', () => {
    const scannedFiles = scannedRoots.flatMap((root) => filesUnder(resolve(repoRoot, root)))
      .filter((file) => !excludedFiles.has(relative(repoRoot, file)))

    expect(scannedFiles.length).toBeGreaterThan(0)

    for (const file of scannedFiles) {
      const rel = relative(repoRoot, file)
      const text = scrubAllowedServiceResource(readFileSync(file, 'utf8'))

      for (const { label, pattern } of forbiddenBoundaryPatterns) {
        expect(text, `${rel} must not cross the service boundary via ${label}`).not.toMatch(pattern)
      }
    }
  })

  it('documents the allowed live bridges as AuroraClient, Gateway transport, and Tauri invoke/listen only', () => {
    const runtimeBridge = readRepo('apps/aurora-tauri/src/aurora-client.ts')
    const tauriApp = readRepo('apps/aurora-tauri/src/tauri-app.tsx')
    const httpTransport = readRepo('packages/aurora-sdk/src/http.ts')
    const tauriTransport = readRepo('packages/aurora-sdk/src/tauri.ts')

    expect(runtimeBridge).toContain("from '@aurora/client'")
    expect(runtimeBridge).toContain('new TauriLocalTransport({ invoke, listen })')
    expect(runtimeBridge).toContain('new HttpGatewayTransport({')
    expect(runtimeBridge).toContain('new MockAuroraTransport()')
    expect(tauriApp).toContain('createAuroraTauriRuntime')
    expect(httpTransport).toContain('class HttpGatewayTransport')
    expect(httpTransport).toContain('fetchImpl(`${this.baseUrl}${path}`, init)')
    expect(tauriTransport).toContain('class TauriLocalTransport')
    expect(tauriTransport).toContain('this.invokeCommand<unknown>(this.commands.request')
  })

  it('keeps tauri smoke coverage tied to the service-boundary gate', () => {
    const packageJson = JSON.parse(readRepo('apps/aurora-tauri/package.json')) as { scripts: Record<string, string> }

    expect(packageJson.scripts['test:service-boundary']).toContain('ui-service-boundary.test.ts')
    expect(packageJson.scripts['tauri:smoke:linux']).toContain('test:service-boundary')
  })
})
