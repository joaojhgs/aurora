import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const repoRoot = resolve(appRoot, '..', '..')

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
    expect(webScripts['dev:web']).toBe(
      'NEXT_PUBLIC_AURORA_WEBRTC_ALLOW_INSECURE_LOOPBACK=1 next dev',
    )
    expect(webScripts['dev:web-thin']).toBe('pnpm dev:web')

    for (const scriptValue of [
      rootScripts['dev:web'],
      webScripts['dev:web'],
    ]) {
      expect(scriptValue).not.toMatch(/THIN|WEBRTC_THIN_CLIENT|RUNTIME_MODE/)
    }
  })
})
