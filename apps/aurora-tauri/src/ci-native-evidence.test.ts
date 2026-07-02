import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')

function repoText(path: string) {
  return readFileSync(resolve(repoRoot, path), 'utf8')
}

function workflowJobNames(workflowText: string): string[] {
  return [...workflowText.matchAll(/^\s{2}([A-Za-z0-9_-]+):\n\s{4}name:\s*(.+)$/gm)].map((match) => match[2]!.trim())
}

describe('Tauri CI native evidence contract', () => {
  it('keeps the Linux Tauri smoke script from being only jsdom/web route tests', () => {
    const packageJson = JSON.parse(repoText('apps/aurora-tauri/package.json')) as { scripts: Record<string, string> }

    expect(packageJson.scripts['test:ci-native-evidence']).toContain('ci-native-evidence.test.ts')
    expect(packageJson.scripts['tauri:smoke:linux']).toContain('test:ci-regression-gates')
    expect(packageJson.scripts['test:ci-regression-gates']).toContain('test:e2e:routes')
    expect(packageJson.scripts['test:ci-regression-gates']).toContain('test:e2e:assistant')
    expect(packageJson.scripts['test:ci-regression-gates']).toContain('test:e2e:admin')
    expect(packageJson.scripts['test:ci-regression-gates']).toContain('test:e2e:runtime')
    expect(packageJson.scripts['test:ci-regression-gates']).toContain('test:ci-native-evidence')
  })

  it('requires desktop-native Tauri evidence outside the web/frontend route crawl', () => {
    const desktopWorkflow = repoText('.github/workflows/tauri-desktop.yml')
    const frontendWorkflow = repoText('.github/workflows/frontend-sdk.yml')

    expect(frontendWorkflow).toContain('pnpm --filter @aurora/tauri-ui test:ci-regression-gates')
    expect(desktopWorkflow).toContain('cargo check')
    expect(desktopWorkflow).toContain('xvfb-run -a pnpm --filter @aurora/tauri-ui dev:smoke')
    expect(desktopWorkflow).toContain('apps/aurora-tauri/reports/tauri-dev-smoke.json')
    expect(desktopWorkflow).toContain('pnpm --filter @aurora/tauri-ui eventstream:smoke')
    expect(desktopWorkflow).toContain('apps/aurora-tauri/reports/eventstream-smoke.json')
    expect(desktopWorkflow).toContain('if-no-files-found: warn')
  })

  it('keeps Tauri and frontend CI check names canonical and non-duplicative', () => {
    const workflowExpectations: Array<[string, string, string[]]> = [
      ['.github/workflows/frontend-sdk.yml', 'Frontend and SDK', ['SDK, shared UI, and web app']],
      ['.github/workflows/tauri-desktop.yml', 'Tauri Desktop Verification', ['Linux Tauri check and smoke launch', 'Sidecar profile staging (${{ matrix.profile }})']],
      ['.github/workflows/tauri-android.yml', 'Tauri Android Verification', ['Android APK build and emulator smoke']],
      ['.github/workflows/tauri-ios.yml', 'Tauri iOS Baseline', ['macOS Xcode Tauri iOS init and build']],
      ['.github/workflows/tauri-ios-release.yml', 'Tauri iOS Policy and Signing', ['iOS manifest and UI policy', 'macOS Xcode iOS preflight']],
      ['.github/workflows/e2e.yml', 'End-to-End Tests', ['Mesh transport E2E harness']],
    ]
    const seen = new Set<string>()

    for (const [path, workflowName, jobs] of workflowExpectations) {
      const text = repoText(path)
      expect(text, path).toContain(`name: ${workflowName}`)
      for (const job of jobs) {
        expect(workflowJobNames(text), `${path} should expose clear job name ${job}`).toContain(job)
        const key = `${workflowName} / ${job}`
        expect(seen.has(key), `${key} should not be duplicated`).toBe(false)
        seen.add(key)
      }
    }
  })

  it('requires mobile preflight policy gates without claiming unsupported signing or platform capabilities', () => {
    const packageJson = JSON.parse(repoText('apps/aurora-tauri/package.json')) as { scripts: Record<string, string> }
    const androidWorkflow = repoText('.github/workflows/tauri-android.yml')
    const iosBaselineWorkflow = repoText('.github/workflows/tauri-ios.yml')
    const iosPolicyWorkflow = repoText('.github/workflows/tauri-ios-release.yml')

    expect(packageJson.scripts['android:preflight:ci']).toBe('node ./scripts/android-preflight.mjs --require-android-project')
    expect(packageJson.scripts['ios:policy']).toBe('node ./scripts/ios-preflight.mjs --policy-only')
    expect(androidWorkflow).toContain('pnpm --filter @aurora/tauri-ui android:preflight:ci')
    expect(androidWorkflow).toContain('pnpm --filter @aurora/tauri-ui android:smoke')
    expect(iosBaselineWorkflow).toContain('runs-on: macos-latest')
    expect(iosBaselineWorkflow).toContain('CODE_SIGNING_ALLOWED: "NO"')
    expect(iosPolicyWorkflow).toContain('pnpm --filter @aurora/tauri-ui ios:policy')
    expect(iosPolicyWorkflow).toContain("if: inputs.app_store_dry_run == 'true'")
    expect(iosPolicyWorkflow).toContain('APPLE_API_KEY_ID: ${{ secrets.APPLE_API_KEY_ID }}')
  })

  it('uploads failing route screenshots, traces, and logs from CI gates', () => {
    const frontendWorkflow = repoText('.github/workflows/frontend-sdk.yml')
    const desktopWorkflow = repoText('.github/workflows/tauri-desktop.yml')

    expect(frontendWorkflow).toContain('if: always()')
    expect(frontendWorkflow).toContain('apps/aurora-tauri/reports/')
    expect(frontendWorkflow).toContain('apps/aurora-tauri/test-results/')
    expect(frontendWorkflow).toContain('apps/aurora-tauri/playwright-report/')
    expect(desktopWorkflow).toContain('Upload Tauri dev smoke report')
    expect(desktopWorkflow).toContain('if: always()')
    expect(desktopWorkflow).toContain('Upload EventStream smoke report')
  })

  it('documents a single CI regression script covering route assistant admin runtime native and boundary gates', () => {
    const packageJson = JSON.parse(repoText('apps/aurora-tauri/package.json')) as { scripts: Record<string, string> }
    const gate = packageJson.scripts['test:ci-regression-gates']

    expect(gate).toContain('test:e2e:routes')
    expect(gate).toContain('test:e2e:assistant')
    expect(gate).toContain('test:e2e:admin')
    expect(gate).toContain('test:e2e:runtime')
    expect(gate).toContain('test:e2e:outcomes')
    expect(gate).toContain('test:ci-native-evidence')
    expect(gate).toContain('test:service-boundary')
    expect(packageJson.scripts['tauri:smoke:linux']).toContain('test:ci-regression-gates')
  })

})
