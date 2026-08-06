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

function generatedDesktopClientConfigText() {
  const tmpRoot = mkdtempSync(join(tmpdir(), 'aurora-ci-native-client-config-'))
  const configPath = join(tmpRoot, 'tauri.client.conf.json')
  execFileSync(process.execPath, [resolve(repoRoot, 'apps/aurora-tauri/scripts/prepare-client-bundle.mjs')], {
    cwd: resolve(repoRoot, 'apps/aurora-tauri'),
    env: {
      ...process.env,
      AURORA_TAURI_CLIENT_CONFIG_PATH: configPath,
      AURORA_TAURI_CLIENT_REPORT_PATH: join(tmpRoot, 'desktop-client-bundle-prepare.json')
    }
  })
  return readFileSync(configPath, 'utf8')
}

const pendingIosNativeTargetClaims = [
  {
    id: 'shareExtension',
    integrationId: 'ios-share-extension',
    releaseGateId: 'share-extension-flow',
    capability: 'ios.shareExtension',
    permission: 'aurora.ios.shareExtension',
    entrypointId: 'ios_share_extension',
    booleanKeys: ['shareExtensionAvailable'],
  },
  {
    id: 'widgets',
    integrationId: 'ios-widget-status',
    releaseGateId: 'simulator-plugin-app-intent',
    capability: 'ios.widgets',
    permission: 'aurora.ios.widgets',
    entrypointId: 'ios_widget',
    booleanKeys: ['widgetsAvailable'],
  },
  {
    id: 'fileAssociations',
    integrationId: 'ios-share-extension',
    releaseGateId: 'share-extension-flow',
    capability: 'ios.fileAssociations',
    permission: 'aurora.ios.fileAssociations',
    entrypointId: 'ios_file_association',
    booleanKeys: ['fileAssociationsAvailable'],
  },
] as const

const supportedIosPublicActionMappings = [
  ['askAuroraAppIntent', 'app-intent.open-assistant'],
  ['askAuroraShortcut', 'shortcut.open-assistant'],
  ['summarizeSharedContentShortcut', 'share.import-context'],
  ['stopAuroraSpeechAppIntent', 'app-intent.stop-speech'],
  ['deepLinks', 'deeplink.open'],
] as const

const forbiddenIosUserFacingReadinessTerms = [
  /\bproof\b/i,
  /\bmacOS\b/i,
  /\bXcode\b/i,
  /\bsimulator\b/i,
  /\bdevice invocation\b/i,
] as const

describe('Tauri CI native evidence contract', () => {
  it('keeps the Linux Tauri smoke script from being only jsdom/web route tests', () => {
    const packageJson = JSON.parse(repoText('apps/aurora-tauri/package.json')) as { scripts: Record<string, string> }

    expect(packageJson.scripts.build).toContain('pnpm --dir ../.. --filter @aurora/client build')
    expect(packageJson.scripts['test:ci-native-evidence']).toContain('ci-native-evidence.test.ts')
    expect(packageJson.scripts['tauri:smoke:linux']).toContain('test:ci-regression-gates')
    expect(packageJson.scripts['test:ci-regression-gates']).toContain('test:e2e:routes')
    expect(packageJson.scripts['test:ci-regression-gates']).toContain('test:e2e:assistant')
    expect(packageJson.scripts['test:ci-regression-gates']).toContain('test:e2e:admin')
    expect(packageJson.scripts['test:ci-regression-gates']).toContain('test:e2e:runtime')
    expect(packageJson.scripts['test:ci-regression-gates']).toContain('test:ci-native-evidence')
    expect(packageJson.scripts['test:ci-regression-gates']).toContain('test:desktop-client-bundle')
  })

  it('requires desktop-native Tauri evidence outside the web/frontend route crawl', () => {
    const desktopWorkflow = repoText('.github/workflows/tauri-desktop.yml')
    const frontendWorkflow = repoText('.github/workflows/frontend-sdk.yml')
    const cargoManifest = repoText('apps/aurora-tauri/src-tauri/Cargo.toml')
    const tauriConfig = repoText('apps/aurora-tauri/src-tauri/tauri.conf.json')
    const tauriLib = repoText('apps/aurora-tauri/src-tauri/src/lib.rs')

    expect(frontendWorkflow).toContain('pnpm --filter @aurora/tauri-ui test:ci-regression-gates')
    expect(desktopWorkflow).toContain('cargo check')
    expect(desktopWorkflow).toContain('xvfb-run -a pnpm --filter @aurora/tauri-ui dev:smoke')
    expect(desktopWorkflow).toContain('AURORA_TAURI_DEV_SMOKE_TIMEOUT_MS: "360000"')
    expect(desktopWorkflow).toContain('apps/aurora-tauri/reports/tauri-dev-smoke.json')
    expect(desktopWorkflow).toContain('pnpm --filter @aurora/tauri-ui eventstream:smoke')
    expect(desktopWorkflow).toContain('apps/aurora-tauri/reports/eventstream-smoke.json')
    expect(desktopWorkflow).toContain('pnpm --filter @aurora/tauri-ui sidecar:runtime:smoke')
    expect(desktopWorkflow).toContain('apps/aurora-tauri/reports/sidecar-runtime-smoke.json')
    expect(desktopWorkflow).toContain('if-no-files-found: warn')
    expect(tauriLib).toContain('.transparent(true)')
    expect(cargoManifest).toContain('"macos-private-api"')
    expect(tauriConfig).toContain('"macOSPrivateApi": true')
  })

  it('boots the packaged sidecar against persistent runtime paths before bundling', () => {
    const packageJson = JSON.parse(repoText('apps/aurora-tauri/package.json')) as { scripts: Record<string, string> }
    const smoke = repoText('apps/aurora-tauri/scripts/sidecar-runtime-smoke.mjs')

    expect(packageJson.scripts['sidecar:runtime:smoke']).toBe(
      'node ./scripts/sidecar-runtime-smoke.mjs',
    )
    expect(smoke).toContain("AURORA_TAURI_MANAGED_SIDECAR: '1'")
    expect(smoke).toContain('AURORA_CONFIG_FILE: join(runtimeDir,')
    expect(smoke).toContain('AURORA_ENV_FILE: join(runtimeDir,')
    expect(smoke).toContain('AURORA_DATA_DIR: join(runtimeDir,')
    expect(smoke).toContain("payload.status !== 'healthy'")
    expect(smoke).toContain('payload.services.healthy !== payload.services.total')
    expect(smoke).toContain('report.persistentState.configFileCreated')
    expect(smoke).toContain('secretsRedacted: true')
  })

  it('prepares clean-runner SDK and WebRTC dependencies before exercising them', () => {
    const rootPackage = JSON.parse(repoText('package.json')) as {
      devDependencies?: Record<string, string>
    }
    const frontendWorkflow = repoText('.github/workflows/frontend-sdk.yml')
    const conformanceWorkflow = repoText('.github/workflows/sdk-backend-contract-conformance.yml')
    const interopWorkflow = repoText('.github/workflows/webrtc-interop.yml')
    const sdkBuild = 'pnpm --filter @aurora/client build'
    const sdkTest = 'pnpm --filter @aurora/client test'
    const playwrightInstall = 'pnpm exec playwright install --with-deps chromium'
    const tauriRegressionGate = 'pnpm --filter @aurora/tauri-ui test:ci-regression-gates'

    expect(frontendWorkflow.indexOf(sdkBuild)).toBeLessThan(
      frontendWorkflow.indexOf(sdkTest),
    )
    expect(conformanceWorkflow.indexOf(sdkBuild)).toBeLessThan(
      conformanceWorkflow.indexOf(sdkTest),
    )
    expect(frontendWorkflow.indexOf(playwrightInstall)).toBeLessThan(
      frontendWorkflow.indexOf(tauriRegressionGate),
    )
    expect(rootPackage.devDependencies?.esbuild).toBeDefined()
    expect(interopWorkflow).toContain('uv sync --extra sidecar-thin')
    expect(interopWorkflow).not.toContain('uv sync --all-extras')
  })

  it('keeps Tauri and frontend CI check names canonical and non-duplicative', () => {
    const workflowExpectations: Array<[string, string, string[]]> = [
      ['.github/workflows/frontend-sdk.yml', 'Frontend and SDK', ['SDK, shared UI, and web app']],
      ['.github/workflows/tauri-desktop.yml', 'Tauri Desktop Verification', ['Desktop Tauri bundle (${{ matrix.bundle_mode }})', 'Desktop client package (${{ matrix.platform }})', 'Sidecar profile staging (${{ matrix.profile }})']],
      ['.github/workflows/tauri-android.yml', 'Tauri Android Verification', ['Android client APK/AAB build and emulator smoke']],
      ['.github/workflows/tauri-ios.yml', 'Tauri iOS Baseline', ['macOS Xcode Tauri iOS init and build']],
      ['.github/workflows/tauri-ios-release.yml', 'Tauri iOS Policy and Signing', ['iOS manifest and UI policy', 'macOS Xcode iOS preflight']],
      ['.github/workflows/python-tests.yml', 'Python Tests', ['Unit, integration, and E2E tests']],
      ['.github/workflows/webrtc-interop.yml', 'WebRTC live interop', ['Hosted peer and cross-engine network paths']],
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
    const androidClientBuildWrapper = repoText('apps/aurora-tauri/scripts/build-android-client-bundle.mjs')
    const androidSmoke = repoText('apps/aurora-tauri/scripts/android-emulator-smoke.mjs')
    const androidInteropRunner = repoText('apps/aurora-tauri/scripts/run-android-webrtc-interop.mjs')
    const iosInteropTest = repoText('apps/aurora-tauri/tests/ios/ios-python-webrtc.e2e.test.ts')
    const iosSimulatorSmoke = repoText('apps/aurora-tauri/scripts/ios-simulator-smoke.mjs')
    const iosEvidenceGate = repoText('apps/aurora-tauri/scripts/assert-ios-ci-evidence.mjs')

    expect(packageJson.scripts['android:sync-native-plugin']).toBe('node ./scripts/install-android-native-plugin.mjs')
    expect(packageJson.scripts['android:init']).toContain('android:sync-native-plugin')
    expect(packageJson.scripts['android:preflight:ci']).toBe('pnpm android:sync-native-plugin && node ./scripts/android-preflight.mjs --require-android-project')
    for (const [name, command] of Object.entries(packageJson.scripts).filter(([name, command]) => name.startsWith('android:build:') && command.includes('tauri android build'))) {
      expect(command, `${name} must sync canonical native plugin before build`).toContain('android:sync-native-plugin')
    }
    expect(packageJson.scripts['android:build:client:apk']).toBe('node ./scripts/build-android-client-bundle.mjs --kind apk')
    expect(packageJson.scripts['android:build:thin:apk']).toBe('pnpm android:build:client:apk')
    expect(packageJson.scripts['android:build:thin:apk']).not.toBe('node ./scripts/build-android-thin-bundle.mjs --kind apk')
    expect(packageJson.scripts['android:build:client:apk:arm64']).toBe(
      'node ./scripts/build-android-client-bundle.mjs --kind apk --target aarch64',
    )
    expect(packageJson.scripts['android:build:thin:apk:arm64']).toBe('pnpm android:build:client:apk:arm64')
    expect(packageJson.scripts['android:build:client:aab']).toBe('node ./scripts/build-android-client-bundle.mjs --kind aab')
    expect(packageJson.scripts['android:build:thin:aab']).toBe('pnpm android:build:client:aab')
    expect(packageJson.scripts['android:build:thin:aab']).not.toBe('node ./scripts/build-android-thin-bundle.mjs --kind aab')
    expect(androidClientBuildWrapper).toContain("run('pnpm', ['android:sync-native-plugin'])")
    expect(androidClientBuildWrapper).toContain("buildArgs.push('--config', tempConfigPath)")
    expect(androidClientBuildWrapper).toContain('sourceConfigWritten: false')
    expect(androidClientBuildWrapper).toContain('rmSync(sourceConfigPath, { force: true })')
    expect(packageJson.scripts['ios:policy']).toBe('node ./scripts/ios-preflight.mjs --policy-only')
    expect(packageJson.scripts['ios:prepare:client']).toBe('node ./scripts/prepare-ios-client-bundle.mjs')
    expect(packageJson.scripts['ios:prepare:thin']).toBe('pnpm ios:prepare:client')
    expect(packageJson.scripts['ios:prepare:thin']).not.toContain('prepare-ios-thin-bundle.mjs')
    expect(packageJson.scripts['ios:build:client:simulator']).toBe('node ./scripts/build-ios-client-bundle.mjs')
    expect(packageJson.scripts['ios:build:thin:simulator']).toBe('pnpm ios:build:client:simulator')
    expect(packageJson.scripts['ios:build:thin:simulator']).not.toContain('build-ios-thin-bundle.mjs')
    expect(packageJson.scripts['ios:smoke:simulator']).toContain('ios-simulator-smoke.mjs')
    expect(packageJson.scripts['ios:webrtc:mobile-browser']).toContain(
      'ios-python-webrtc.e2e.test.ts',
    )
    expect(packageJson.scripts['ios:webrtc:interop']).toContain(
      'ios-python-webrtc.e2e.test.ts',
    )
    expect(packageJson.scripts['ios:webrtc:interop']).toContain(
      '--no-file-parallelism',
    )
    expect(packageJson.scripts['ios:webrtc:wkwebview']).toContain(
      'packaged Tauri WKWebView',
    )
    expect(iosInteropTest).toContain('buildWkWebViewHarness')
    expect(iosInteropTest).toContain('beforeBuildCommand: null')
    expect(iosInteropTest).toContain(
      'AURORA_IOS_MOBILE_WEBRTC_TIMEOUT_MS ?? 600_000',
    )
    expect(iosInteropTest).toContain('const cleanupTimeoutMs = 60_000')
    expect(iosInteropTest).toContain('}, cleanupTimeoutMs)')
    expect(iosInteropTest).toContain('server.closeAllConnections()')
    expect(iosInteropTest).toContain('await Promise.all(shutdowns)')
    expect(iosInteropTest).toContain('frontendDist: distDir')
    expect(iosInteropTest).not.toContain("frontendDist: './dist'")
    expect(iosInteropTest).toContain('const iosBuildRoot = join(')
    expect(iosInteropTest).toContain(
      'await fs.rm(iosBuildRoot, { recursive: true, force: true })',
    )
    expect(iosInteropTest).toContain(
      'redactIosWebRtcArtifactLog(log)',
    )
    expect(iosInteropTest).toContain(
      "kind: 'packaged-tauri-wkwebview'",
    )
    expect(iosInteropTest).toContain(
      'pythonSidecarPackaged: false',
    )
    expect(iosInteropTest).toContain(
      "browserName: 'ios-tauri-wkwebview-simulator'",
    )
    expect(iosInteropTest).toContain("id: 'mobile-safari'")
    expect(iosInteropTest).toContain("id: 'tauri-wkwebview'")
    expect(iosInteropTest).toContain(
      'for (const surface of surfaces)',
    )
    expect(iosInteropTest).toContain('assertInteropBrowserResult')
    expect(iosInteropTest).toContain('assertIosScreenshotVisible')
    expect(iosInteropTest).toContain('screenshotEvidence')
    expect(iosInteropTest).toContain('-webkit-text-size-adjust: 100%')
    expect(iosInteropTest).toContain('data-aurora-ios-evidence="webrtc"')
    expect(iosInteropTest).toContain(
      'const mqttImportMapJson = \'{"imports":{"mqtt":"/mqtt-bundle.mjs"}}\'',
    )
    expect(
      iosInteropTest.match(
        /<script type="importmap">\$\{mqttImportMapJson\}<\/script>/gu,
      ),
    ).toHaveLength(1)
    expect(iosInteropTest).toContain(
      "surface.id === 'tauri-wkwebview'",
    )
    expect(iosInteropTest).toContain(
      "? ['--external:mqtt']",
    )
    expect(iosInteropTest).toContain(
      "const mqttImportMapCspHash = `sha256-${crypto",
    )
    expect(iosInteropTest).toContain(
      "`script-src 'self' '${mqttImportMapCspHash}'`",
    )
    expect(iosInteropTest).toContain('function mobileInteropFailure')
    expect(iosInteropTest).toContain(
      'gatewayHttpApiEnabled: false',
    )
    expect(iosInteropTest).toContain(
      'artifactProof: wkWebViewHarness.artifactProof',
    )
    expect(iosInteropTest).toContain(
      'function inspectWkWebViewArtifact',
    )
    expect(iosInteropTest).toContain(
      'forbiddenMatchCount: 0',
    )
    expect(packageJson.scripts['build:frontend:ios-client']).toBe('node ./scripts/build-ios-client-frontend.mjs')
    expect(packageJson.scripts['build:frontend:ios-thin']).toBe('pnpm build:frontend:ios-client')
    expect(androidWorkflow).toContain('pnpm --filter @aurora/tauri-ui android:preflight:ci')
    expect(androidWorkflow).toContain('pnpm --filter @aurora/tauri-ui android:build:client:apk:x86_64')
    expect(androidWorkflow).not.toContain('pnpm --filter @aurora/tauri-ui android:build:client:apk\n')
    expect(androidWorkflow).toContain('pnpm --filter @aurora/tauri-ui android:verify:client:apk')
    expect(androidWorkflow).toContain('pnpm --filter @aurora/tauri-ui android:build:client:aab')
    expect(androidWorkflow).toContain('pnpm --filter @aurora/tauri-ui android:verify:client:aab')
    expect(androidWorkflow).toContain('Retain Android client smoke APK')
    expect(androidWorkflow).toContain('apps/aurora-tauri/reports/android-client-smoke.apk')
    expect(androidWorkflow.indexOf('Retain Android client smoke APK')).toBeLessThan(
      androidWorkflow.indexOf('pnpm --filter @aurora/tauri-ui android:build:client:aab'),
    )
    expect(androidWorkflow).toContain(
      'AURORA_ANDROID_APK: ${{ github.workspace }}/apps/aurora-tauri/reports/android-client-smoke.apk',
    )
    expect(androidWorkflow).not.toContain('AURORA_TAURI_ANDROID_ALLOWED_REMOTE_ORIGINS')
    expect(androidWorkflow).not.toContain('AURORA_TAURI_THIN_CONNECTION_MODE: "webrtc-only"')
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
    expect(androidSmoke).toContain('function launchApp')
    expect(androidSmoke).toContain("['shell', 'am', 'start', '-n', `${appId}/.MainActivity`]")
    expect(androidSmoke).toContain("adbOutput(['shell', 'pidof', appId], { allowNonzero: true })")
    expect(androidSmoke).toContain("'RustStdoutStderr:I'")
    expect(androidSmoke).toContain("'*:S'")
    expect(packageJson.scripts['android:build:thin:apk']).not.toMatch(/python|uv/i)
    expect(packageJson.scripts['android:build:thin:aab']).not.toMatch(/python|uv/i)
    expect(androidWorkflow).toContain('Set up Python interop peer')
    expect(androidWorkflow).toContain('Install uv for the external Python peer')
    expect(androidWorkflow).toContain('uv sync --extra sidecar-thin')
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
    expect(iosBaselineWorkflow).toContain('pnpm --filter @aurora/tauri-ui ios:build:client:simulator')
    expect(iosBaselineWorkflow).not.toContain('AURORA_TAURI_IOS_ALLOWED_REMOTE_ORIGINS')
    expect(iosBaselineWorkflow).not.toContain('AURORA_TAURI_THIN_CONNECTION_MODE: "webrtc-only"')
    expect(iosBaselineWorkflow).not.toContain('https://gateway.example.invalid')
    expect(repoText('apps/aurora-tauri/scripts/build-ios-client-bundle.mjs')).toContain('ios-client-simulator-build-provenance.json')
    expect(iosBaselineWorkflow).toContain('ios-client-simulator-build-provenance.json')
    expect(iosBaselineWorkflow).toContain('pnpm --filter @aurora/tauri-ui ios:smoke:simulator')
    expect(iosBaselineWorkflow).toContain('ios-simulator-smoke.json')
    expect(iosBaselineWorkflow).toContain('src/ios-simulator-smoke.test.ts')
    expect(iosBaselineWorkflow).toContain('src/ios-ci-evidence.test.ts')
    expect(iosBaselineWorkflow).toContain('src/ci-native-evidence.test.ts')
    expect(iosBaselineWorkflow).toContain('assert-ios-ci-evidence.mjs')
    expect(iosBaselineWorkflow).not.toContain('if-no-files-found: warn')
    expect(iosSimulatorSmoke).toContain('analyzeIosScreenshot')
    expect(iosSimulatorSmoke).toContain('AURORA_IOS_SIMULATOR_RENDER_TIMEOUT_MS')
    expect(iosEvidenceGate).toContain("'mobile-safari'")
    expect(iosEvidenceGate).toContain("'packaged-wkwebview'")
    expect(iosEvidenceGate).toContain('noHttpFetchTransportUsed === true')
    expect(iosBaselineWorkflow).toContain('Set up Python interop peer')
    expect(iosBaselineWorkflow).toContain('python-version: "3.11"')
    expect(iosBaselineWorkflow).toContain('Install uv for the external Python peer')
    expect(iosBaselineWorkflow).toContain('uv sync --extra sidecar-thin')
    expect(iosBaselineWorkflow).toContain('brew install mosquitto')
    expect(iosBaselineWorkflow).toContain(
      'pnpm --filter @aurora/tauri-ui ios:webrtc:interop',
    )
    expect(iosBaselineWorkflow).toContain(
      'apps/aurora-tauri/reports/webrtc-interop/ios-mobile-safari/',
    )
    expect(iosBaselineWorkflow).toContain(
      'apps/aurora-tauri/reports/webrtc-interop/ios-wkwebview/',
    )
    expect(iosPolicyWorkflow).toContain('pnpm --filter @aurora/tauri-ui ios:policy')
    expect(iosPolicyWorkflow).toContain("if: inputs.app_store_dry_run == 'true'")
    expect(iosPolicyWorkflow).toContain('APPLE_API_KEY_ID: ${{ secrets.APPLE_API_KEY_ID }}')
  })

  it('keeps pending iOS native targets from claiming runtime availability before preflight proof exists', () => {
    const preflight = JSON.parse(repoText('apps/aurora-tauri/src-tauri/ios/preflight.json')) as {
      integrations: Array<{ id: string; status: string }>
      releaseGates: Array<{ id: string; status: string }>
    }
    const swiftPlugin = repoText(
      'apps/aurora-tauri/src-tauri/ios/AuroraNativePlugin/Sources/AuroraNativePlugin/AuroraNativePlugin.swift',
    )
    const swiftEntrypoints = repoText(
      'apps/aurora-tauri/src-tauri/ios/AuroraNativePlugin/Sources/AuroraNativePlugin/AuroraEntrypointPayloads.swift',
    )
    const app = repoText('apps/aurora-tauri/src/tauri-app.tsx')

    expect(swiftPlugin).toContain('private static let pendingNativeTargetReason')
    expect(swiftEntrypoints).toContain('private static let pendingNativeTargetReason')
    expect(app).toContain('state === "degraded" || state?.startsWith("pending")')
    expect(app).not.toContain('status as unknown as { state?: unknown }')
    expect(swiftPlugin).toContain('let hasPendingNativeTargets = mobileIntegrations.contains')
    expect(swiftPlugin).toContain('let invocationState = hasPendingNativeTargets ? "degraded" : "available"')
    expect(swiftPlugin).toContain('"state": invocationState')
    expect(swiftPlugin).toContain('.map { $0["publicActionId"] as? String ?? "" }')
    expect(swiftPlugin).toContain('($0["publicActionId"] as? String) == request.action && ($0["support"] as? String) == "supported-path"')

    for (const [internalId, publicActionId] of supportedIosPublicActionMappings) {
      const manifestBlock = swiftPlugin.match(
        new RegExp(`"id": "${internalId}"[\\s\\S]*?"verifier": "[^"]+"`),
      )?.[0] ?? ''
      expect(manifestBlock, internalId).toContain(`"publicActionId": "${publicActionId}"`)
      expect(manifestBlock, internalId).toContain('"support": "supported-path"')
    }

    for (const claim of pendingIosNativeTargetClaims) {
      const integration = preflight.integrations.find(({ id }) => id === claim.integrationId)
      const releaseGate = preflight.releaseGates.find(({ id }) => id === claim.releaseGateId)
      expect(integration, claim.integrationId).toBeDefined()
      expect(releaseGate, claim.releaseGateId).toBeDefined()
      expect(
        ['pending', 'partial', 'requires-macos', 'requires-credentials'].includes(releaseGate?.status ?? ''),
        `${claim.releaseGateId} must remain a non-proof gate until Xcode evidence exists`,
      ).toBe(true)

      const manifestBlock = swiftPlugin.match(
        new RegExp(`"id": "${claim.id}"[\\s\\S]*?"verifier": "[^"]+"`),
      )?.[0] ?? ''
      expect(manifestBlock, claim.id).toContain('"support": "pending"')
      expect(manifestBlock, claim.id).toContain('"reason": AuroraNativePlugin.pendingNativeTargetReason')
      expect(manifestBlock, claim.id).not.toContain('"publicActionId"')
      expect(manifestBlock, claim.id).not.toContain('"support": "supported-path"')

      const descriptorBlock = swiftEntrypoints.match(
        new RegExp(`id: "${claim.entrypointId}"[\\s\\S]*?reason: pendingNativeTargetReason`),
      )?.[0] ?? ''
      expect(descriptorBlock, claim.entrypointId).toContain('state: "pending_native_target"')
      expect(descriptorBlock, claim.entrypointId).toContain('available: false')
      expect(descriptorBlock, claim.entrypointId).not.toContain('state: "available"')
      expect(descriptorBlock, claim.entrypointId).not.toContain('available: true')

      expect(swiftPlugin, `${claim.permission} permission boolean`).toContain(`"${claim.permission}": false`)
      expect(swiftPlugin, `${claim.capability} capability boolean`).toContain(`"${claim.capability}": false`)
      expect(swiftPlugin, `${claim.permission} permission state`).toContain(`"${claim.permission}": "pending_native_target"`)
      expect(swiftPlugin, `${claim.capability} capability state`).toContain(`"${claim.capability}": "pending_native_target"`)
      for (const key of claim.booleanKeys) {
        expect(swiftPlugin, key).toContain(`"${key}": false`)
        expect(swiftPlugin, key).not.toContain(`"${key}": true`)
      }
    }

    expect(swiftEntrypoints).toContain('id: "ios_deep_link"')
    expect(swiftEntrypoints).toContain('state: "available"')
    expect(swiftEntrypoints).toContain('available: true')
    expect(swiftPlugin).toContain('"deepLinksAvailable": true')
    expect(swiftPlugin).toContain('"ios.deepLinks": "available"')
    expect(swiftPlugin).toContain('.filter { ($0["support"] as? String) == "supported-path" }')
  })

  it('keeps user-facing pending iOS readiness copy free of verifier wording', () => {
    const swiftPlugin = repoText(
      'apps/aurora-tauri/src-tauri/ios/AuroraNativePlugin/Sources/AuroraNativePlugin/AuroraNativePlugin.swift',
    )
    const swiftEntrypoints = repoText(
      'apps/aurora-tauri/src-tauri/ios/AuroraNativePlugin/Sources/AuroraNativePlugin/AuroraEntrypointPayloads.swift',
    )
    const pendingReasonConstant =
      swiftPlugin.match(/private static let pendingNativeTargetReason = "([^"]+)"/)?.[1] ?? ''
    const entrypointPendingReasonConstant =
      swiftEntrypoints.match(/private static let pendingNativeTargetReason = "([^"]+)"/)?.[1] ?? ''
    const aggregateInvocationReason =
      swiftPlugin.match(/\?\s+"([^"]+)"\s+:\s+NSNull\(\)/)?.[1] ?? ''
    const iosInvocationManifestReason =
      swiftPlugin.match(/"iosInvocation": \[[\s\S]*?"reason": "([^"]+)"/)?.[1] ?? ''

    expect(pendingReasonConstant).toBe('This iOS feature is unavailable until mobile app setup is complete.')
    expect(entrypointPendingReasonConstant).toBe(pendingReasonConstant)
    for (const value of [
      pendingReasonConstant,
      entrypointPendingReasonConstant,
      aggregateInvocationReason,
      iosInvocationManifestReason,
    ]) {
      assertNoForbiddenIosReadinessCopy(value)
    }

    for (const claim of pendingIosNativeTargetClaims) {
      const manifestBlock = swiftPlugin.match(
        new RegExp(`"id": "${claim.id}"[\\s\\S]*?"verifier": "[^"]+"`),
      )?.[0] ?? ''
      expect(manifestBlock, claim.id).toContain('"reason": AuroraNativePlugin.pendingNativeTargetReason')
      const userCopy = manifestBlock.match(/"userCopy": "([^"]+)"/)?.[1] ?? ''
      assertNoForbiddenIosReadinessCopy(userCopy)
    }
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
    expect(gate).toContain('test:desktop-client-bundle')
    expect(gate).toContain('test:service-boundary')
    expect(packageJson.scripts['tauri:smoke:linux']).toContain('test:ci-regression-gates')
  })

  it('treats generated SQL schema vocabulary as catalog metadata, not granted capability', () => {
    const capabilities = JSON.parse(repoText('apps/aurora-tauri/src-tauri/gen/schemas/capabilities.json')) as Record<
      string,
      { permissions: string[] }
    >
    const desktopSchema = repoText('apps/aurora-tauri/src-tauri/gen/schemas/desktop-schema.json')
    const aclManifests = repoText('apps/aurora-tauri/src-tauri/gen/schemas/acl-manifests.json')
    const rustMain = repoText('apps/aurora-tauri/src-tauri/src/lib.rs')

    expect(desktopSchema).toContain('"const": "sql:allow-select"')
    expect(aclManifests).toContain('"sql"')
    for (const [name, capability] of Object.entries(capabilities)) {
      expect(
        capability.permissions.filter((permission) => permission.startsWith('sql:')),
        `${name} must not grant generic SQL WebView commands`,
      ).toEqual([])
      if (capability.permissions.includes('aurora-local-data-storage')) {
        expect(
          capability.permissions,
          `${name} should grant only Aurora local-data commands for local data`,
        ).toContain('aurora-local-data-envelope-crypto')
      }
    }
    expect(rustMain).toContain('generated schema catalogs may list')
    expect(rustMain).toContain('src-tauri/capabilities is the permission grant source')
  })


  it('keeps python3-dev out of the desktop-thin matrix prerequisites', () => {
    const workflow = repoText('.github/workflows/tauri-desktop.yml')
    const commonInstall = workflow.match(/- name: Install Tauri Linux prerequisites[\s\S]*?- name: Install desktop-local Python prerequisites/)?.[0] ?? ''
    const localPythonInstall = workflow.match(/- name: Install desktop-local Python prerequisites[\s\S]*?- name: Set up Python/)?.[0] ?? ''

    expect(commonInstall).not.toContain('python3-dev')
    expect(localPythonInstall).toContain('if: matrix.needs_python')
    expect(localPythonInstall).toContain('python3-dev')
  })

  it('packages every client WebRTC surface with its required runtime and permission contract', () => {
    const cargo = repoText('apps/aurora-tauri/src-tauri/Cargo.toml')
    const thinCapability = repoText(
      'apps/aurora-tauri/src-tauri/capabilities/aurora-thin.json',
    )
    const nativeWebRtcPermission = repoText(
      'apps/aurora-tauri/src-tauri/permissions/aurora-native-webrtc.toml',
    )
    const windowsConfig = JSON.parse(
      repoText('apps/aurora-tauri/src-tauri/tauri.windows.conf.json'),
    ) as {
      bundle: {
        windows: {
          webviewInstallMode: { type: string }
        }
      }
    }
    const macosConfig = JSON.parse(
      repoText('apps/aurora-tauri/src-tauri/tauri.macos.conf.json'),
    ) as {
      bundle: {
        macOS: {
          hardenedRuntime: boolean
          entitlements: string
          infoPlist: string
        }
      }
    }
    const macosPlist = repoText(
      `apps/aurora-tauri/src-tauri/${macosConfig.bundle.macOS.infoPlist}`,
    )
    const macosEntitlements = repoText(
      `apps/aurora-tauri/src-tauri/${macosConfig.bundle.macOS.entitlements}`,
    )
    const iosPlist = repoText(
      'apps/aurora-tauri/src-tauri/Info.ios.plist',
    )
    const androidManifest = repoText(
      'apps/aurora-tauri/src-tauri/android/aurora-native-plugin/src/main/AndroidManifest.xml',
    )
    const barcodeManifest = repoText(
      'apps/aurora-tauri/src-tauri/vendor/tauri-plugin-barcode-scanner/android/src/main/AndroidManifest.xml',
    )
    const androidPlugin = repoText(
      'apps/aurora-tauri/src-tauri/android/aurora-native-plugin/src/main/java/dev/aurora/tauri/nativeplugin/AuroraNativePlugin.kt',
    )
    const androidSyncScript = repoText(
      'apps/aurora-tauri/scripts/install-android-native-plugin.mjs',
    )
    const desktopWorkflow = repoText(
      '.github/workflows/tauri-desktop.yml',
    )

    const linuxDependencies =
      cargo.match(
        /\[target\.'cfg\(target_os = "linux"\)'\.dependencies\]([\s\S]*?)(?=\n\[|$)/,
      )?.[1] ?? ''
    const commonDependencies =
      cargo.match(/\[dependencies\]([\s\S]*?)(?=\n\[|$)/)?.[1] ?? ''
    expect(linuxDependencies).toContain('webrtc = "0.11.0"')
    expect(`${commonDependencies}\n${linuxDependencies}`).toContain(
      'base64 = "=0.22.1"',
    )
    expect(linuxDependencies).toContain('bytes = "1"')
    expect(cargo).not.toContain('webkit2gtk =')
    expect(thinCapability).toContain('"aurora-native-webrtc"')
    expect(nativeWebRtcPermission).toContain(
      'aurora_native_webrtc_create',
    )
    expect(nativeWebRtcPermission).toContain(
      'aurora_native_webrtc_data_channel_send',
    )

    expect(windowsConfig.bundle.windows.webviewInstallMode.type).toBe(
      'embedBootstrapper',
    )
    expect(macosConfig.bundle.macOS.infoPlist).toBe(
      'Info.macos.plist',
    )
    expect(macosConfig.bundle.macOS.hardenedRuntime).toBe(true)
    expect(macosConfig.bundle.macOS.entitlements).toBe(
      'entitlements.macos.plist',
    )
    expect(macosPlist).toContain('NSMicrophoneUsageDescription')
    expect(macosPlist).toContain('NSLocalNetworkUsageDescription')
    expect(macosEntitlements).toContain(
      'com.apple.security.device.audio-input',
    )

    expect(iosPlist).toContain('NSCameraUsageDescription')
    expect(iosPlist).toContain('NSMicrophoneUsageDescription')
    expect(iosPlist).toContain('NSLocalNetworkUsageDescription')
    expect(iosPlist).toContain('NSAppTransportSecurity')

    for (const permission of [
      'android.permission.INTERNET',
      'android.permission.ACCESS_NETWORK_STATE',
      'android.permission.RECORD_AUDIO',
      'android.permission.MODIFY_AUDIO_SETTINGS',
    ]) {
      expect(androidManifest).toContain(permission)
    }
    expect(barcodeManifest).toContain('android.permission.CAMERA')
    expect(androidManifest).toContain('android.software.webview')
    expect(androidManifest).toContain('android:usesCleartextTraffic="true"')
    expect(androidSyncScript).toContain('android.software.webview')
    expect(androidSyncScript).toContain('android:usesCleartextTraffic="true"')
    expect(androidPlugin).toContain(
      'override fun onPermissionRequest(request: PermissionRequest)',
    )
    expect(androidPlugin).toContain(
      'PermissionRequest.RESOURCE_AUDIO_CAPTURE',
    )

    expect(desktopWorkflow).toContain(
      'Desktop client package (${{ matrix.platform }})',
    )
    expect(desktopWorkflow).toContain('os: macos-latest')
    expect(desktopWorkflow).toContain('os: windows-latest')
    expect(desktopWorkflow).toContain(
      'pnpm --filter @aurora/tauri-ui build:bundle:desktop-client',
    )
    expect(desktopWorkflow).toContain(
      'apps/aurora-tauri/src-tauri/target/release/bundle/**',
    )
  })

  it('defines a Python-free desktop client bundle lane with deterministic artifact proof and thin aliases', () => {
    const packageJson = JSON.parse(repoText('apps/aurora-tauri/package.json')) as { scripts: Record<string, string> }
    const prepareClient = repoText('apps/aurora-tauri/scripts/prepare-client-bundle.mjs')
    const assertClient = repoText('apps/aurora-tauri/scripts/assert-client-bundle-clean.mjs')
    const prepareThin = repoText('apps/aurora-tauri/scripts/prepare-thin-bundle.mjs')
    const assertThin = repoText('apps/aurora-tauri/scripts/assert-thin-bundle-clean.mjs')
    const thinCapability = repoText('apps/aurora-tauri/src-tauri/capabilities/aurora-thin.json')
    const clientConfig = generatedDesktopClientConfigText()
    const workflow = repoText('.github/workflows/tauri-desktop.yml')

    expect(packageJson.scripts['build:bundle:desktop-local']).toBe('pnpm build:bundle:desktop-local-minimal')
    expect(packageJson.scripts['build:bundle:thin']).toBe('pnpm build:bundle:desktop-client')
    for (const [name, command] of Object.entries(packageJson.scripts)) {
      if (!name.endsWith(':thin') && !name.endsWith(':client')) continue
      expect(command, `${name} must be Python-free`).not.toMatch(/prepare-sidecar|python/i)
    }
    expect(packageJson.scripts['prepare:bundle:desktop-client']).toBe('node ./scripts/prepare-client-bundle.mjs')
    expect(packageJson.scripts['prepare:bundle:desktop-thin']).toBe('pnpm prepare:bundle:desktop-client')
    expect(packageJson.scripts['verify:bundle:desktop-client']).toBe('node ./scripts/assert-client-bundle-clean.mjs')
    expect(packageJson.scripts['verify:bundle:desktop-thin']).toBe('pnpm verify:bundle:desktop-client')
    expect(packageJson.scripts['test:desktop-client-bundle']).toContain('desktop-client-bundle-proof.test.ts')
    expect(packageJson.scripts['test:desktop-thin-bundle']).toBe('pnpm test:desktop-client-bundle')
    expect(packageJson.scripts['build:bundle:desktop-client']).toContain('prepare-client-bundle.mjs')
    expect(packageJson.scripts['build:bundle:desktop-client']).toContain('src-tauri/tauri.client.conf.json')
    expect(packageJson.scripts['build:bundle:desktop-client']).toContain('assert-client-bundle-clean.mjs')
    expect(packageJson.scripts['build:bundle:desktop-thin']).toBe('pnpm build:bundle:desktop-client')
    expect(packageJson.scripts['build:bundle:desktop-thin']).not.toContain('prepare-thin-bundle.mjs')
    expect(packageJson.scripts['build:bundle:desktop-thin']).not.toContain('prepare-sidecar')
    expect(prepareClient).toContain("const connectSrc = [\"'self'\", 'http:', 'https:', 'ws:', 'wss:']")
    expect(prepareClient).toContain("capabilities: ['aurora-thin']")
    expect(prepareClient).toContain("connectionMode: 'runtime-configurable'")
    expect(prepareThin).toContain("await import('./prepare-client-bundle.mjs')")
    expect(assertClient).toContain('forbiddenPathPatterns')
    expect(assertClient).toContain('aurora-sidecar')
    expect(assertClient).toContain('config_defaults')
    expect(assertClient).toContain('site-packages')
    expect(assertClient).toContain('archivesFound')
    expect(assertClient).toContain('failed to inspect deb archive')
    expect(assertThin).toContain("await import('./assert-client-bundle-clean.mjs')")
    expect(thinCapability).toContain('aurora-thin-profile')
    expect(thinCapability).toContain('aurora-thin-peer-credentials')
    expect(thinCapability).not.toContain('aurora-secure-storage')
    expect(thinCapability).not.toContain('aurora-sidecar')
    expect(thinCapability).not.toContain('aurora-request')
    expect(thinCapability).not.toContain('aurora-subscribe')
    expect(thinCapability).not.toContain('aurora-local-file')
    expect(thinCapability).not.toContain('aurora-audio-bridge')
    expect(clientConfig).toContain('aurora-thin')
    expect(clientConfig).toContain("connect-src 'self' http: https: ws: wss:")
    expect(clientConfig).not.toContain('wss://signaling.example.invalid')
    expect(clientConfig).not.toContain('https://gateway.example.invalid')
    expect(clientConfig).not.toContain('binaries/aurora-sidecar')
    expect(clientConfig).not.toContain('config_defaults.json')
    expect(workflow).toContain('Desktop Tauri bundle (${{ matrix.bundle_mode }})')
    expect(workflow).toContain('desktop-client')
    expect(workflow).toContain('desktop-local')
    expect(workflow).toContain('pnpm --filter @aurora/tauri-ui build:bundle:${{ matrix.bundle_mode }}')
    expect(workflow).toContain('pnpm --filter @aurora/tauri-ui verify:bundle:desktop-client')
    expect(workflow).not.toContain('AURORA_TAURI_ALLOWED_REMOTE_ORIGINS')
    expect(workflow).not.toContain('AURORA_TAURI_THIN_CONNECTION_MODE: webrtc-only')
    expect(workflow).not.toContain('https://gateway.example.invalid')
    expect(workflow).toContain('Install desktop-local Python prerequisites')
    expect(workflow).toContain('if: matrix.needs_python')
  })

  it('keeps outgoing mobile actions behind bounded platform commands and generated ACLs', () => {
    const rust = repoText('apps/aurora-tauri/src-tauri/src/lib.rs')
    const buildManifest = repoText('apps/aurora-tauri/src-tauri/build.rs')
    const kotlin = repoText(
      'apps/aurora-tauri/src-tauri/android/aurora-native-plugin/src/main/java/dev/aurora/tauri/nativeplugin/AuroraNativePlugin.kt',
    )
    const androidManifest = repoText(
      'apps/aurora-tauri/src-tauri/android/aurora-native-plugin/src/main/AndroidManifest.xml',
    )
    const swift = repoText(
      'apps/aurora-tauri/src-tauri/ios/AuroraNativePlugin/Sources/AuroraNativePlugin/AuroraNativePlugin.swift',
    )
    const androidPermission = repoText(
      'apps/aurora-tauri/src-tauri/permissions/aurora-android-native-plugin.toml',
    )
    const iosPermission = repoText(
      'apps/aurora-tauri/src-tauri/permissions/aurora-ios-native-plugin.toml',
    )
    const mobileActionsPermission = repoText(
      'apps/aurora-tauri/src-tauri/permissions/aurora-mobile-native-actions.toml',
    )
    const capabilities = JSON.parse(
      repoText('apps/aurora-tauri/src-tauri/gen/schemas/capabilities.json'),
    ) as Record<string, { permissions: string[]; platforms?: string[] }>
    const mobileSchemas = [
      repoText('apps/aurora-tauri/src-tauri/gen/schemas/android-schema.json'),
      repoText('apps/aurora-tauri/src-tauri/gen/schemas/mobile-schema.json'),
    ]
    const acl = JSON.parse(
      repoText('apps/aurora-tauri/src-tauri/gen/schemas/acl-manifests.json'),
    ) as {
      '__app-acl__': {
        permissions: Record<string, { commands: { allow: string[] } }>
      }
    }
    const commands = [
      'aurora_native_share_text',
      'aurora_native_open_deep_link',
      'aurora_native_show_notification',
    ]
    for (const command of commands) {
      expect(rust).toContain(`async fn ${command}`)
      expect(buildManifest).toContain(`"${command}"`)
      expect(mobileActionsPermission).toContain(`"${command}"`)
      expect(androidPermission).not.toContain(`"${command}"`)
      expect(iosPermission).not.toContain(`"${command}"`)
      expect(
        acl['__app-acl__'].permissions['aurora-android-native-plugin']?.commands.allow,
      ).not.toContain(command)
      expect(
        acl['__app-acl__'].permissions['aurora-ios-native-plugin']?.commands.allow,
      ).not.toContain(command)
      expect(
        acl['__app-acl__'].permissions['aurora-mobile-native-actions']?.commands.allow,
      ).toContain(command)
      for (const schema of mobileSchemas) {
        expect(schema).toContain(`allow-${command.replaceAll('_', '-')}`)
        expect(schema).toContain(`deny-${command.replaceAll('_', '-')}`)
      }
    }
    for (const schema of mobileSchemas) {
      expect(schema).toContain('"const": "aurora-mobile-native-actions"')
    }

    expect(capabilities['aurora-mobile-mesh']?.platforms).toEqual(['android', 'iOS'])
    expect(capabilities['aurora-mobile-mesh']?.permissions).toContain(
      'aurora-mobile-native-actions',
    )
    for (const identifier of ['aurora-main', 'aurora-thin']) {
      const capability = capabilities[identifier]
      expect(capability?.permissions).not.toContain('aurora-mobile-native-actions')
      const allowedDesktopCommands = (capability?.permissions ?? []).flatMap(
        (permission) =>
          acl['__app-acl__'].permissions[permission]?.commands.allow ?? [],
      )
      for (const command of commands) {
        expect(allowedDesktopCommands, `${identifier} must not grant ${command}`).not.toContain(
          command,
        )
      }
    }

    for (const action of ['shareText', 'openDeepLink', 'showNotification']) {
      expect(kotlin).toContain(`fun ${action}(invoke: Invoke)`)
      expect(swift).toContain(`@objc public func ${action}(_ invoke: Invoke)`)
    }
    expect(androidManifest).toContain('<queries>')
    expect(kotlin).toContain('canResolveExternalIntent')
    expect(kotlin).toContain('it.packageName != activity.packageName')
    expect(kotlin).toContain('Intent.EXTRA_EXCLUDE_COMPONENTS')
    expect(kotlin).toContain('NotificationManagerCompat.from(activity).areNotificationsEnabled()')
    expect(swift).toContain('UNUserNotificationCenter.current().getNotificationSettings')
    expect(`${kotlin}\n${swift}`).not.toMatch(/requestAuthorization\(/u)
    expect(`${kotlin}\n${swift}`).not.toMatch(/(?:Runtime|getRuntime)\.exec|ProcessBuilder|\/bin\/sh/u)
    expect(rust).not.toContain('aurora_native_invoke')
  })

})

function assertNoForbiddenIosReadinessCopy(value: string) {
  expect(value).not.toBe('')
  for (const pattern of forbiddenIosUserFacingReadinessTerms) {
    expect(value, `${value} should keep verifier wording out of user-facing iOS readiness copy`).not.toMatch(pattern)
  }
}
