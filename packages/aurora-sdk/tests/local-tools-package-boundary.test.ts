import { existsSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const packageJsonPath = resolve(packageRoot, 'package.json')
const rootIndexPath = resolve(packageRoot, 'src/index.ts')

function read(path: string): string {
  return readFileSync(path, 'utf8')
}

describe('local Tooling package boundary', () => {
  it('publishes local Tooling through a stable dedicated subpath', () => {
    const pkg = JSON.parse(read(packageJsonPath))

    expect(pkg.exports['./local-tools']).toEqual({
      types: './dist/local-tools/index.d.ts',
      import: './dist/local-tools/index.js',
      default: './dist/local-tools/index.js'
    })
  })

  it('does not widen the root SDK source graph with local Tooling authority', () => {
    const root = read(rootIndexPath)

    expect(root).not.toMatch(/from ['"]\.\/local-tools(?:\/index)?\.js['"]/u)
    expect(root).not.toContain('LocalToolRegistry')
    expect(root).not.toContain('createLocalToolingProviderHandlers')
  })

  it('imports the source subpath under Node/SSR without browser globals', async () => {
    const oldWindow = (globalThis as Record<string, unknown>).window
    const oldCrypto = (globalThis as Record<string, unknown>).crypto
    try {
      delete (globalThis as Record<string, unknown>).window
      delete (globalThis as Record<string, unknown>).crypto
      const mod = await import('../src/local-tools/index.js')

      expect(mod.LocalToolRegistry).toBeTypeOf('function')
      expect(mod.LocalToolExecutionPolicy).toBeTypeOf('function')
      expect(mod.createLocalToolingProviderHandlers).toBeTypeOf('function')
      expect(mod.DurableFeatureSharingController).toBeTypeOf('function')
      expect(mod.TrackingPeerPairingIssuer).toBeTypeOf('function')
    } finally {
      if (oldWindow !== undefined) (globalThis as Record<string, unknown>).window = oldWindow
      if (oldCrypto !== undefined) (globalThis as Record<string, unknown>).crypto = oldCrypto
    }
  })

  it('points package exports at emitted build artifacts', () => {
    const pkg = JSON.parse(read(packageJsonPath))

    for (const target of Object.values(pkg.exports['./local-tools']) as string[]) {
      expect(target.startsWith('./dist/')).toBe(true)
      expect(existsSync(resolve(packageRoot, target))).toBe(true)
    }
  })
})
