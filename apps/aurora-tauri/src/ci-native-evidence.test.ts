import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')

function repoText(path: string) {
  return readFileSync(resolve(repoRoot, path), 'utf8')
}

function workflowJobNames(workflowText: string): string[] {
  return [...workflowText.matchAll(/^\s{2}([A-Za-z0-9_-]+):\n\s{4}name:\s*(.+)$/gm)].map((match) => match[2]!.trim())
}

function generatedDesktopThinConfigText() {
  const tmpRoot = mkdtempSync(join(tmpdir(), 'aurora-ci-native-thin-config-'))
  const configPath = join(tmpRoot, 'tauri.thin.conf.json')
  execFileSync(process.execPath, [resolve(repoRoot, 'apps/aurora-tauri/scripts/prepare-thin-bundle.mjs')], {
    cwd: resolve(repoRoot, 'apps/aurora-tauri'),
    env: {
      ...process.env,
      AURORA_TAURI_ALLOWED_REMOTE_ORIGINS: 'wss://signaling.example.invalid',
      AURORA_TAURI_THIN_CONNECTION_MODE: 'webrtc-only',
      AURORA_TAURI_THIN_CONFIG_PATH: configPath,
      AURORA_TAURI_THIN_REPORT_PATH: join(tmpRoot, 'desktop-thin-bundle-prepare.json')
    }
  })
  return readFileSync(configPath, 'utf8')
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
    expect(packageJson.scripts['test:ci-regression-gates']).toContain('test:desktop-thin-bundle')
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
      ['.github/workflows/tauri-desktop.yml', 'Tauri Desktop Verification', ['Desktop Tauri bundle (${{ matrix.bundle_mode }})', 'Sidecar profile staging (${{ matrix.profile }})']],
      ['.github/workflows/tauri-android.yml', 'Tauri Android Verification', ['Android thin APK/AAB build and emulator smoke']],
      ['.github/workflows/tauri-ios.yml', 'Tauri iOS Baseline', ['macOS Xcode Tauri iOS init and build']],
      ['.github/workflows/tauri-ios-release.yml', 'Tauri iOS Policy and Signing', ['iOS manifest and UI policy', 'macOS Xcode iOS preflight']],
      ['.github/workflows/python-tests.yml', 'Python Tests', ['Unit, integration, and E2E tests']],
      ['.github/workflows/webrtc-interop.yml', 'WebRTC live interop', ['Browser persistence and cross-engine network paths']],
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
    const androidThinBuildWrapper = repoText('apps/aurora-tauri/scripts/build-android-thin-bundle.mjs')
    const androidInteropRunner = repoText('apps/aurora-tauri/scripts/run-android-webrtc-interop.mjs')

    expect(packageJson.scripts['android:sync-native-plugin']).toBe('node ./scripts/install-android-native-plugin.mjs')
    expect(packageJson.scripts['android:init']).toContain('android:sync-native-plugin')
    expect(packageJson.scripts['android:preflight:ci']).toBe('pnpm android:sync-native-plugin && node ./scripts/android-preflight.mjs --require-android-project')
    for (const [name, command] of Object.entries(packageJson.scripts).filter(([name, command]) => name.startsWith('android:build:') && command.includes('tauri android build'))) {
      expect(command, `${name} must sync canonical native plugin before build`).toContain('android:sync-native-plugin')
    }
    expect(packageJson.scripts['android:build:thin:apk']).toBe('node ./scripts/build-android-thin-bundle.mjs --kind apk')
    expect(packageJson.scripts['android:build:thin:aab']).toBe('node ./scripts/build-android-thin-bundle.mjs --kind aab')
    expect(androidThinBuildWrapper).toContain("run('pnpm', ['android:sync-native-plugin'])")
    expect(androidThinBuildWrapper).toContain("buildArgs.push('--config', tempConfigPath)")
    expect(androidThinBuildWrapper).toContain('sourceConfigWritten: false')
    expect(androidThinBuildWrapper).toContain('rmSync(sourceConfigPath, { force: true })')
    expect(packageJson.scripts['ios:policy']).toBe('node ./scripts/ios-preflight.mjs --policy-only')
    expect(packageJson.scripts['ios:prepare:thin']).toContain('prepare-ios-thin-bundle.mjs')
    expect(packageJson.scripts['ios:build:thin:simulator']).toContain('build-ios-thin-bundle.mjs')
    expect(packageJson.scripts['ios:smoke:simulator']).toContain('ios-simulator-smoke.mjs')
    expect(packageJson.scripts['ios:webrtc:mobile-browser']).toContain(
      'ios-browser-python-webrtc.e2e.test.ts',
    )
    expect(packageJson.scripts['build:frontend:ios-thin']).toBe('node ./scripts/build-ios-thin-frontend.mjs')
    expect(androidWorkflow).toContain('pnpm --filter @aurora/tauri-ui android:preflight:ci')
    expect(androidWorkflow).toContain('pnpm --filter @aurora/tauri-ui android:build:thin:apk')
    expect(androidWorkflow).toContain('pnpm --filter @aurora/tauri-ui android:verify:thin:apk')
    expect(androidWorkflow).toContain('pnpm --filter @aurora/tauri-ui android:build:thin:aab')
    expect(androidWorkflow).toContain('pnpm --filter @aurora/tauri-ui android:verify:thin:aab')
    expect(androidWorkflow).toContain('AURORA_TAURI_ANDROID_ALLOWED_REMOTE_ORIGINS')
    expect(androidWorkflow).toContain('AURORA_TAURI_ANDROID_ALLOWED_REMOTE_ORIGINS: "wss://signaling.example.invalid"')
    expect(androidWorkflow).toContain('AURORA_TAURI_THIN_CONNECTION_MODE: "webrtc-only"')
    expect(androidWorkflow).not.toContain('https://gateway.example.invalid')
    expect(androidWorkflow).toContain('"platforms;android-35"')
    expect(androidWorkflow).toContain('"platforms;android-36"')
    for (const target of [
      'aarch64-linux-android',
      'armv7-linux-androideabi',
      'i686-linux-android',
      'x86_64-linux-android',
    ]) {
      expect(androidWorkflow, `Android AAB CI must install Rust target ${target}`).toContain(target)
    }
    expect(packageJson.scripts['android:webrtc:interop']).toBe(
      'node ./scripts/run-android-webrtc-interop.mjs',
    )
    expect(androidInteropRunner).toContain(
      'android-python-webrtc.e2e.test.ts',
    )
    expect(androidInteropRunner).toContain(
      'android-browser-python-webrtc.e2e.test.ts',
    )
    expect(androidInteropRunner).toContain(
      'android-aggregate-report.json',
    )
    expect(androidInteropRunner).toContain(
      'aurora.android_webrtc_interop.aggregate.v1',
    )
    expect(packageJson.scripts['android:build:thin:apk']).not.toMatch(/python|uv/i)
    expect(packageJson.scripts['android:build:thin:aab']).not.toMatch(/python|uv/i)
    expect(androidWorkflow).toContain('Set up Python interop peer')
    expect(androidWorkflow).toContain('Install uv for the external Python peer')
    expect(androidWorkflow).toContain('uv sync --extra gateway')
    expect(androidWorkflow).toContain('pnpm --filter @aurora/tauri-ui android:smoke')
    expect(androidWorkflow).toContain('pnpm --filter @aurora/tauri-ui android:webrtc:interop')
    expect(androidWorkflow).toContain(
      'apps/aurora-tauri/reports/webrtc-interop/',
    )
    expect(androidWorkflow).toContain('api-level: 30')
    expect(androidWorkflow).toContain('api-level: 35')
    expect(androidWorkflow).toContain('Android 11 baseline WebView and native payload E2E')
    expect(androidWorkflow).toContain(
      'Android 15 current WebView, mobile browser, native payload, and Python peer WebRTC E2E',
    )
    expect(iosBaselineWorkflow).toContain('runs-on: macos-latest')
    expect(iosBaselineWorkflow).toContain('CODE_SIGNING_ALLOWED: "NO"')
    expect(iosBaselineWorkflow).toContain('pnpm --filter @aurora/tauri-ui ios:build:thin:simulator')
    expect(iosBaselineWorkflow).toContain('AURORA_TAURI_IOS_ALLOWED_REMOTE_ORIGINS')
    expect(iosBaselineWorkflow).toContain('AURORA_TAURI_IOS_ALLOWED_REMOTE_ORIGINS: "wss://signaling.example.invalid"')
    expect(iosBaselineWorkflow).toContain('AURORA_TAURI_THIN_CONNECTION_MODE: "webrtc-only"')
    expect(iosBaselineWorkflow).not.toContain('https://gateway.example.invalid')
    expect(iosBaselineWorkflow).toContain('ios-thin-simulator-build-provenance.json')
    expect(iosBaselineWorkflow).toContain('pnpm --filter @aurora/tauri-ui ios:smoke:simulator')
    expect(iosBaselineWorkflow).toContain('ios-simulator-smoke.json')
    expect(iosBaselineWorkflow).toContain('Set up Python interop peer')
    expect(iosBaselineWorkflow).toContain('Install uv for the external Python peer')
    expect(iosBaselineWorkflow).toContain('uv sync --extra gateway')
    expect(iosBaselineWorkflow).toContain('brew install mosquitto')
    expect(iosBaselineWorkflow).toContain(
      'pnpm --filter @aurora/tauri-ui ios:webrtc:mobile-browser',
    )
    expect(iosBaselineWorkflow).toContain(
      'apps/aurora-tauri/reports/webrtc-interop/ios-mobile-safari/',
    )
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
    expect(gate).toContain('test:desktop-thin-bundle')
    expect(gate).toContain('test:service-boundary')
    expect(packageJson.scripts['tauri:smoke:linux']).toContain('test:ci-regression-gates')
  })


  it('keeps python3-dev out of the desktop-thin matrix prerequisites', () => {
    const workflow = repoText('.github/workflows/tauri-desktop.yml')
    const commonInstall = workflow.match(/- name: Install Tauri Linux prerequisites[\s\S]*?- name: Install desktop-local Python prerequisites/)?.[0] ?? ''
    const localPythonInstall = workflow.match(/- name: Install desktop-local Python prerequisites[\s\S]*?- name: Set up Python/)?.[0] ?? ''

    expect(commonInstall).not.toContain('python3-dev')
    expect(localPythonInstall).toContain('if: matrix.needs_python')
    expect(localPythonInstall).toContain('python3-dev')
  })

  it('defines a Python-free desktop-thin bundle lane with deterministic artifact proof', () => {
    const packageJson = JSON.parse(repoText('apps/aurora-tauri/package.json')) as { scripts: Record<string, string> }
    const prepareThin = repoText('apps/aurora-tauri/scripts/prepare-thin-bundle.mjs')
    const assertThin = repoText('apps/aurora-tauri/scripts/assert-thin-bundle-clean.mjs')
    const thinCapability = repoText('apps/aurora-tauri/src-tauri/capabilities/aurora-thin.json')
    const thinConfig = generatedDesktopThinConfigText()
    const workflow = repoText('.github/workflows/tauri-desktop.yml')

    expect(packageJson.scripts['build:bundle:desktop-local']).toBe('pnpm build:bundle:desktop-local-minimal')
    expect(packageJson.scripts['build:bundle:thin']).toBe('pnpm build:bundle:desktop-thin')
    for (const [name, command] of Object.entries(packageJson.scripts)) {
      if (!name.endsWith(':thin')) continue
      expect(command, `${name} must be Python-free`).not.toMatch(/prepare-sidecar|python/i)
    }
    expect(packageJson.scripts['prepare:bundle:desktop-thin']).toBe('node ./scripts/prepare-thin-bundle.mjs')
    expect(packageJson.scripts['verify:bundle:desktop-thin']).toBe('node ./scripts/assert-thin-bundle-clean.mjs')
    expect(packageJson.scripts['test:desktop-thin-bundle']).toContain('desktop-thin-bundle-proof.test.ts')
    expect(packageJson.scripts['build:bundle:desktop-thin']).toContain('prepare-thin-bundle.mjs')
    expect(packageJson.scripts['build:bundle:desktop-thin']).toContain('src-tauri/tauri.thin.conf.json')
    expect(packageJson.scripts['build:bundle:desktop-thin']).toContain('assert-thin-bundle-clean.mjs')
    expect(packageJson.scripts['build:bundle:desktop-thin']).not.toContain('prepare-sidecar')
    expect(prepareThin).toContain('AURORA_TAURI_ALLOWED_REMOTE_ORIGINS')
    expect(prepareThin).toContain("capabilities: ['aurora-thin']")
    expect(prepareThin).not.toContain('http: https: ws: wss:')
    expect(assertThin).toContain('forbiddenPathPatterns')
    expect(assertThin).toContain('aurora-sidecar')
    expect(assertThin).toContain('config_defaults')
    expect(assertThin).toContain('site-packages')
    expect(assertThin).toContain('archivesFound')
    expect(assertThin).toContain('failed to inspect deb archive')
    expect(thinCapability).toContain('aurora-thin-profile')
    expect(thinCapability).toContain('aurora-thin-peer-credentials')
    expect(thinCapability).not.toContain('aurora-secure-storage')
    expect(thinCapability).not.toContain('aurora-sidecar')
    expect(thinCapability).not.toContain('aurora-request')
    expect(thinCapability).not.toContain('aurora-subscribe')
    expect(thinCapability).not.toContain('aurora-local-file')
    expect(thinCapability).not.toContain('aurora-audio-bridge')
    expect(thinConfig).toContain('aurora-thin')
    expect(thinConfig).toContain('wss://signaling.example.invalid')
    expect(thinConfig).not.toContain('https://gateway.example.invalid')
    expect(thinConfig).not.toContain('binaries/aurora-sidecar')
    expect(thinConfig).not.toContain('config_defaults.json')
    expect(workflow).toContain('Desktop Tauri bundle (${{ matrix.bundle_mode }})')
    expect(workflow).toContain('desktop-thin')
    expect(workflow).toContain('desktop-local')
    expect(workflow).toContain('pnpm --filter @aurora/tauri-ui build:bundle:${{ matrix.bundle_mode }}')
    expect(workflow).toContain('pnpm --filter @aurora/tauri-ui verify:bundle:desktop-thin')
    expect(workflow).toContain('AURORA_TAURI_ALLOWED_REMOTE_ORIGINS')
    expect(workflow).toContain('AURORA_TAURI_ALLOWED_REMOTE_ORIGINS: wss://signaling.example.invalid')
    expect(workflow).toContain('AURORA_TAURI_THIN_CONNECTION_MODE: webrtc-only')
    expect(workflow).not.toContain('https://gateway.example.invalid')
    expect(workflow).toContain('Install desktop-local Python prerequisites')
    expect(workflow).toContain('if: matrix.needs_python')
  })

})
