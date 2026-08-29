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

describe('lightweight orchestrator package boundary', () => {
  it('publishes the bounded assistant through a dedicated subpath', () => {
    const pkg = JSON.parse(read(packageJsonPath))

    expect(pkg.exports['./lightweight-orchestrator']).toEqual({
      types: './dist/lightweight-orchestrator/index.d.ts',
      import: './dist/lightweight-orchestrator/index.js',
      default: './dist/lightweight-orchestrator/index.js'
    })
  })

  it('does not widen the root SDK graph with provider credentials or local execution authority', () => {
    const root = read(rootIndexPath)

    expect(root).not.toMatch(/from ['"]\.\/lightweight-orchestrator(?:\/index)?\.js['"]/u)
    expect(root).not.toContain('createOpenAICompatibleToolProvider')
    expect(root).not.toContain('createLightweightOrchestrator')
  })

  it('imports under Node without creating a provider or reading browser globals', async () => {
    const oldWindow = (globalThis as Record<string, unknown>).window
    try {
      delete (globalThis as Record<string, unknown>).window
      const mod = await import('../src/lightweight-orchestrator/index.js')

      expect(mod.LightweightOrchestrator).toBeTypeOf('function')
      expect(mod.createLightweightOrchestrator).toBeTypeOf('function')
      expect(mod.createOpenAICompatibleToolProvider).toBeTypeOf('function')
    } finally {
      if (oldWindow !== undefined) (globalThis as Record<string, unknown>).window = oldWindow
    }
  }, 30_000)

  it('points package exports at emitted build artifacts', () => {
    const pkg = JSON.parse(read(packageJsonPath))

    for (const target of Object.values(pkg.exports['./lightweight-orchestrator']) as string[]) {
      expect(target.startsWith('./dist/')).toBe(true)
      expect(existsSync(resolve(packageRoot, target))).toBe(true)
    }
  })
})
