import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')

function repoText(path: string) {
  return readFileSync(resolve(repoRoot, path), 'utf8')
}

describe('Tauri CI native evidence contract', () => {
  it('keeps the Linux Tauri smoke script from being only jsdom/web route tests', () => {
    const packageJson = JSON.parse(repoText('apps/aurora-tauri/package.json')) as { scripts: Record<string, string> }

    expect(packageJson.scripts['test:ci-native-evidence']).toContain('ci-native-evidence.test.ts')
    expect(packageJson.scripts['tauri:smoke:linux']).toContain('test:e2e:routes')
    expect(packageJson.scripts['tauri:smoke:linux']).toContain('test:e2e:assistant')
    expect(packageJson.scripts['tauri:smoke:linux']).toContain('test:e2e:admin')
    expect(packageJson.scripts['tauri:smoke:linux']).toContain('test:e2e:runtime')
    expect(packageJson.scripts['tauri:smoke:linux']).toContain('test:ci-native-evidence')
  })

  it('requires desktop-native Tauri evidence outside the web/frontend route crawl', () => {
    const desktopWorkflow = repoText('.github/workflows/tauri-desktop.yml')
    const frontendWorkflow = repoText('.github/workflows/frontend-sdk.yml')

    expect(frontendWorkflow).toContain('pnpm --filter @aurora/tauri-ui tauri:smoke:linux')
    expect(desktopWorkflow).toContain('cargo check')
    expect(desktopWorkflow).toContain('xvfb-run -a pnpm --filter @aurora/tauri-ui dev:smoke')
    expect(desktopWorkflow).toContain('apps/aurora-tauri/reports/tauri-dev-smoke.json')
    expect(desktopWorkflow).toContain('pnpm --filter @aurora/tauri-ui eventstream:smoke')
    expect(desktopWorkflow).toContain('apps/aurora-tauri/reports/eventstream-smoke.json')
    expect(desktopWorkflow).toContain('if-no-files-found: warn')
  })
})
