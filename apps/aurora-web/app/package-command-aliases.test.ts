import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const repoRoot = resolve(appRoot, '..', '..')

const UI_LAUNCH_PRESETS = [
  'web-remote',
  'web-remote-admin',
  'web-node',
  'desktop-local',
  'desktop-thin-remote',
  'desktop-node',
  'android-remote',
  'android-node',
  'ios-remote',
  'ios-node',
  'mobile-node',
] as const

function packageScripts(path: string) {
  return (
    JSON.parse(readFileSync(path, 'utf8')) as {
      scripts: Record<string, string>
    }
  ).scripts
}

describe('web neutral dev command aliases', () => {
  it('keeps dev:web canonical and dev:web-thin as an exact compatibility alias', () => {
    const rootScripts = packageScripts(resolve(repoRoot, 'package.json'))
    const webScripts = packageScripts(resolve(appRoot, 'package.json'))

    expect(rootScripts['dev:web']).toBe('pnpm --filter @aurora/web dev:web')
    expect(rootScripts['dev:web-thin']).toBe('pnpm dev:web')
    expect(rootScripts['dev:ui:debug']).toBe('pnpm --filter @aurora/web dev:ui:debug')
    expect(webScripts['dev:web']).toBe('node ./scripts/dev-ui-launch.mjs debug')
    expect(webScripts['dev:ui:debug']).toBe('node ./scripts/dev-ui-launch.mjs debug')
    expect(webScripts['dev:web-thin']).toBe('pnpm dev:web')

    for (const scriptValue of [
      rootScripts['dev:web'],
      webScripts['dev:web'],
    ]) {
      expect(scriptValue).not.toMatch(/THIN|WEBRTC_THIN_CLIENT|RUNTIME_MODE/)
    }
  })

  it('exposes random-port UI launch scripts for every surface/role preset', () => {
    const rootScripts = packageScripts(resolve(repoRoot, 'package.json'))
    const webScripts = packageScripts(resolve(appRoot, 'package.json'))

    for (const preset of UI_LAUNCH_PRESETS) {
      const scriptName = `dev:ui:${preset}`
      expect(webScripts[scriptName]).toBe(`node ./scripts/dev-ui-launch.mjs ${preset}`)
      expect(rootScripts[scriptName]).toBe(`pnpm --filter @aurora/web ${scriptName}`)
    }

    const launcher = readFileSync(resolve(appRoot, 'scripts/dev-ui-launch.mjs'), 'utf8')
    expect(launcher).toContain("NEXT_PUBLIC_AURORA_DEBUG_UI: '1'")
    expect(launcher).toContain('--port')
    expect(launcher).toContain('reserveFreePort')
    expect(launcher).toContain('aurora-surface=')
    expect(launcher).toContain('aurora-role=')
    expect(launcher).toContain('aurora-admin=')
    expect(launcher).toContain('aurora-viewport=')
    expect(launcher).toContain("presetId === 'debug'")
    expect(launcher).toContain('AURORA_UI_DEBUG_URL')
    expect(launcher).not.toContain('VITE_AURORA_RUNTIME_MODE')
    expect(launcher).not.toContain('NEXT_PUBLIC_AURORA_DEBUG_UI_NODE_MODE')
    expect(launcher).not.toMatch(/NEXT_PUBLIC_AURORA_DEBUG_UI_PRESET:\s/)
  })
})
