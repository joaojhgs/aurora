// @vitest-environment node

import { execFileSync, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const prepare = join(packageRoot, 'scripts', 'prepare-android-client-bundle.mjs')
const buildClient = join(packageRoot, 'scripts', 'build-android-client-bundle.mjs')
const proof = join(packageRoot, 'scripts', 'assert-android-client-artifact-clean.mjs')
const buildFrontend = join(packageRoot, 'scripts', 'build-android-client-frontend.mjs')
const androidPreflight = join(packageRoot, 'scripts', 'android-preflight.mjs')
const syncNativePlugin = join(packageRoot, 'scripts', 'install-android-native-plugin.mjs')
const canonicalPluginSource = join(packageRoot, 'src-tauri', 'android', 'aurora-native-plugin', 'src', 'main', 'java', 'dev', 'aurora', 'tauri', 'nativeplugin')
const canonicalPluginResources = join(packageRoot, 'src-tauri', 'android', 'aurora-native-plugin', 'src', 'main', 'res')
const vendorBarcodeScanner = join(packageRoot, 'src-tauri', 'vendor', 'tauri-plugin-barcode-scanner')
const vendorBarcodeScannerSource = join(vendorBarcodeScanner, 'android', 'src', 'main', 'java', 'BarcodeScannerPlugin.kt')

type AndroidClientKind = 'apk' | 'aab'
const requiredNativeSpeechLibraries = [
  'libaurora_tauri_lib.so',
  'libonnxruntime.so',
  'libsherpa-onnx-c-api.so',
]

function androidNativeLibraryEntries(
  kind: AndroidClientKind,
  abis = kind === 'aab' ? ['arm64-v8a', 'x86_64'] : ['x86_64'],
) {
  const prefix = kind === 'aab' ? 'base/lib' : 'lib'
  return abis.flatMap((abi) =>
    requiredNativeSpeechLibraries.map((library) => `${prefix}/${abi}/${library}`),
  )
}

function writeNativeSpeechRuntime(directory: string) {
  mkdirSync(directory, { recursive: true })
  for (const library of requiredNativeSpeechLibraries.slice(1)) {
    writeFileSync(join(directory, library), `${library} test fixture\n`)
  }
}

interface AndroidClientProofContext {
  root: string
  buildOutputRoot: string
  configPath: string
  prepareReportPath: string
  apkProvenancePath: string
  aabProvenancePath: string
  apkProofPath: string
  aabProofPath: string
}

function createAndroidClientProofContext(): AndroidClientProofContext {
  const root = mkdtempSync(join(tmpdir(), 'aurora-android-thin-proof-'))
  return {
    root,
    buildOutputRoot: join(root, 'android-build-outputs'),
    configPath: join(root, 'tauri.android-client.conf.json'),
    prepareReportPath: join(root, 'android-client-bundle-prepare.json'),
    apkProvenancePath: join(root, 'android-client-apk-build-provenance.json'),
    aabProvenancePath: join(root, 'android-client-aab-build-provenance.json'),
    apkProofPath: join(root, 'android-client-apk-artifact-proof.json'),
    aabProofPath: join(root, 'android-client-aab-artifact-proof.json'),
  }
}

function androidClientEnv(
  context: AndroidClientProofContext,
  kind: AndroidClientKind = 'apk',
  extra: NodeJS.ProcessEnv = {},
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    AURORA_TAURI_ANDROID_CLIENT_CONFIG_PATH: context.configPath,
    AURORA_TAURI_ANDROID_CLIENT_SOURCE_CONFIG_PATH: context.configPath,
    AURORA_TAURI_ANDROID_BUILD_OUTPUT_ROOT: context.buildOutputRoot,
    AURORA_TAURI_ANDROID_CLIENT_REPORT_PATH: context.prepareReportPath,
    AURORA_TAURI_ANDROID_CLIENT_BUILD_PROVENANCE_PATH:
      kind === 'apk' ? context.apkProvenancePath : context.aabProvenancePath,
    AURORA_TAURI_ANDROID_CLIENT_PROOF_REPORT_PATH:
      kind === 'apk' ? context.apkProofPath : context.aabProofPath,
    ...extra,
  }
  for (const [name, value] of Object.entries(env)) {
    if (value === undefined) delete env[name]
  }
  return env
}

function prepareAndroidClient(
  context: AndroidClientProofContext,
  extra: NodeJS.ProcessEnv = {},
) {
  execFileSync(process.execPath, [prepare], {
    cwd: packageRoot,
    env: androidClientEnv(context, 'apk', extra),
  })
}

function runProof(
  context: AndroidClientProofContext,
  kind: AndroidClientKind,
  artifact: string,
) {
  return spawnSync(process.execPath, [proof, '--kind', kind, '--artifact', artifact], {
    cwd: packageRoot,
    encoding: 'utf8',
    env: androidClientEnv(context, kind),
  })
}

function runProofAuto(
  context: AndroidClientProofContext,
  kind: AndroidClientKind,
  artifactRoot: string,
) {
  return spawnSync(process.execPath, [proof, '--kind', kind], {
    cwd: packageRoot,
    encoding: 'utf8',
    env: androidClientEnv(context, kind, {
      AURORA_ANDROID_CLIENT_ARTIFACT_DIR: artifactRoot,
    }),
  })
}

const describeIfNode = typeof window === 'undefined' ? describe : describe.skip

describeIfNode('Android client bundle artifact proof', () => {
  it('prepares a Python-free Android client overlay with runtime-configurable endpoints', () => {
    const context = createAndroidClientProofContext()
    prepareAndroidClient(context, {
      AURORA_TAURI_ANDROID_ALLOWED_REMOTE_ORIGINS:
        'https://gateway.example.invalid wss://signaling.example.invalid',
      AURORA_TAURI_THIN_CONNECTION_MODE: 'webrtc-only',
    })

    const config = readFileSync(context.configPath, 'utf8')
    const report = readFileSync(context.prepareReportPath, 'utf8')

    expect(config).toContain('aurora-android-thin')
    expect(config).toContain("connect-src 'self' http://ipc.localhost http://127.0.0.1:* http://localhost:* ws://127.0.0.1:* ws://localhost:* https: wss:")
    expect(config).not.toContain('https://gateway.example.invalid')
    expect(config).not.toContain('wss://signaling.example.invalid')
    expect(config).toContain('"externalBin": []')
    expect(config).toContain('"resources": {}')
    expect(config).not.toMatch(/aurora-sidecar|prepare-sidecar|config_defaults\.json|site-packages|\.venv/i)
    expect(report).toContain('"pythonSidecarStaged": false')
    expect(report).toContain('"runtimeConfiguredEndpoints": true')
  })

  it('records no compiled Gateway or signaling origin in the prepare report', () => {
    const context = createAndroidClientProofContext()
    prepareAndroidClient(context)

    const config = JSON.parse(readFileSync(context.configPath, 'utf8'))
    const report = JSON.parse(readFileSync(context.prepareReportPath, 'utf8'))
    expect(config.app.security.csp).toContain("connect-src 'self' http://ipc.localhost http://127.0.0.1:* http://localhost:* ws://127.0.0.1:* ws://localhost:* https: wss:")
    expect(report).toMatchObject({
      bundleMode: 'android-client',
      connectionMode: 'runtime-configurable',
      gatewayOrigin: null,
      signalingOrigin: null,
      runtimeConfiguredEndpoints: true,
    })
  })

  it('grants PCM injection only in the dedicated Android voice live-test overlay', () => {
    const context = createAndroidClientProofContext()
    prepareAndroidClient(context)

    const productionConfig = JSON.parse(readFileSync(context.configPath, 'utf8'))
    const productionReport = JSON.parse(readFileSync(context.prepareReportPath, 'utf8'))
    expect(productionConfig.app.security.capabilities).toEqual([
      'aurora-android-thin',
      'aurora-mobile-mesh',
    ])
    expect(productionReport).toMatchObject({
      bundleMode: 'android-client',
      voiceLiveTest: false,
      expectedCapabilities: ['aurora-android-thin', 'aurora-mobile-mesh'],
    })

    prepareAndroidClient(context, { AURORA_TAURI_ANDROID_VOICE_LIVE_TEST: '1' })
    const liveConfig = JSON.parse(readFileSync(context.configPath, 'utf8'))
    const liveReport = JSON.parse(readFileSync(context.prepareReportPath, 'utf8'))
    expect(liveConfig.app.security.capabilities).toEqual([
      'aurora-android-thin',
      'aurora-mobile-mesh',
      {
        identifier: 'aurora-android-voice-live-e2e-capability',
        description: 'Debug-only capability for the maintained Android native voice live test.',
        windows: ['main'],
        platforms: ['android'],
        permissions: ['aurora-android-voice-live-e2e'],
      },
    ])
    expect(liveReport).toMatchObject({
      bundleMode: 'android-client-voice-live-test',
      voiceLiveTest: true,
      expectedCapabilities: [
        'aurora-android-thin',
        'aurora-mobile-mesh',
        'aurora-android-voice-live-e2e-capability',
      ],
    })
  })

  it('does not inject endpoint defaults or a role into Android client frontend builds', () => {
    const stubDir = mkdtempSync(join(tmpdir(), 'aurora-android-thin-pnpm-'))
    const envPath = join(stubDir, 'frontend-env.json')
    const pnpmStub = join(stubDir, 'pnpm')
    writeFileSync(pnpmStub, `#!/usr/bin/env node\nconst fs = require('node:fs')\nfs.writeFileSync(${JSON.stringify(envPath)}, JSON.stringify({ argv: process.argv.slice(2), gateway: process.env.VITE_AURORA_GATEWAY_URL, signaling: process.env.VITE_AURORA_SIGNALING_URL, connectionMode: process.env.VITE_AURORA_CONNECTION_MODE, mode: process.env.VITE_AURORA_RUNTIME_MODE, webviewTarget: process.env.VITE_AURORA_WEBVIEW_TARGET }, null, 2))\n`)
    chmodSync(pnpmStub, 0o755)

    const ok = spawnSync(process.execPath, [buildFrontend], {
      cwd: packageRoot,
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${stubDir}${delimiter}${process.env.PATH ?? ''}`,
        AURORA_TAURI_ANDROID_ALLOWED_REMOTE_ORIGINS: 'https://gateway.example.invalid/ wss://signaling.example.invalid',
        AURORA_TAURI_THIN_CONNECTION_MODE: 'webrtc-preferred',
      }
    })

    expect(ok.status, ok.stderr).toBe(0)
    const frontendEnv = JSON.parse(readFileSync(envPath, 'utf8'))
    expect(frontendEnv).toMatchObject({
      argv: ['build'],
      gateway: '',
      signaling: '',
      connectionMode: '',
      webviewTarget: 'chrome83',
    })
    expect(frontendEnv.mode).toBeUndefined()

    const webrtcOnly = spawnSync(process.execPath, [buildFrontend], {
      cwd: packageRoot,
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${stubDir}${delimiter}${process.env.PATH ?? ''}`,
        AURORA_TAURI_ANDROID_ALLOWED_REMOTE_ORIGINS:
          'https://unused-gateway.example.invalid wss://signaling.example.invalid',
        AURORA_TAURI_THIN_CONNECTION_MODE: 'webrtc-only',
      },
    })

    expect(webrtcOnly.status, webrtcOnly.stderr).toBe(0)
    expect(JSON.parse(readFileSync(envPath, 'utf8'))).toMatchObject({
      argv: ['build'],
      gateway: '',
      signaling: '',
      connectionMode: '',
      webviewTarget: 'chrome83',
    })
    expect(JSON.parse(readFileSync(envPath, 'utf8')).mode).toBeUndefined()
  })

  it('passes on minimal APK and AAB archives without Python or sidecar entries', () => {
    const context = createAndroidClientProofContext()
    prepareAndroidClient(context)
    const root = mkdtempSync(join(tmpdir(), 'aurora-android-thin-clean-'))
    const apk = join(root, 'app-x86_64-debug.apk')
    const aab = join(root, 'app-debug.aab')
    writeZip(apk, ['AndroidManifest.xml', 'classes.dex', ...androidNativeLibraryEntries('apk')])
    writeZip(aab, ['base/manifest/AndroidManifest.xml', 'base/dex/classes.dex', ...androidNativeLibraryEntries('aab')])

    const apkResult = runProof(context, 'apk', apk)
    const aabResult = runProof(context, 'aab', aab)

    expect(apkResult.status, apkResult.stderr).toBe(0)
    expect(aabResult.status, aabResult.stderr).toBe(0)
    expect(apkResult.stdout).toContain('Android client APK artifact proof passed')
    expect(aabResult.stdout).toContain('Android client AAB artifact proof passed')
  })

  it('verifies from build provenance when the source-tree Android client config is absent', () => {
    const context = createAndroidClientProofContext()
    prepareAndroidClient(context)
    const configRaw = readFileSync(context.configPath, 'utf8')
    const config = JSON.parse(configRaw)
    writeFileSync(context.apkProvenancePath, `${JSON.stringify({
      generatedAt: new Date().toISOString(),
      bundleMode: 'android-client',
      kind: 'apk',
      sourceConfigWritten: false,
      configSha256: createHash('sha256').update(configRaw).digest('hex'),
      config,
      prepareReport: JSON.parse(readFileSync(context.prepareReportPath, 'utf8')),
      pythonSidecarStaged: false,
      secretsRedacted: true,
    }, null, 2)}\n`)
    rmSync(context.configPath, { force: true })

    const root = mkdtempSync(join(tmpdir(), 'aurora-android-thin-provenance-artifact-'))
    const apk = join(root, 'app-x86_64-debug.apk')
    writeZip(apk, ['AndroidManifest.xml', 'classes.dex', ...androidNativeLibraryEntries('apk')])

    const result = runProof(context, 'apk', apk)

    expect(result.status, result.stderr).toBe(0)
    expect(readFileSync(context.apkProofPath, 'utf8')).toContain(
      '"configSource": "build-provenance"',
    )
    expect(existsSync(context.configPath)).toBe(false)
  })

  it('builds Android client bundles through a temp config and records reusable provenance', () => {
    const context = createAndroidClientProofContext()
    const stubDir = mkdtempSync(join(tmpdir(), 'aurora-android-thin-build-pnpm-'))
    const arm64NativeLibDir = join(stubDir, 'native', 'arm64-v8a')
    const x86_64NativeLibDir = join(stubDir, 'native', 'x86_64')
    const jdkHome = join(stubDir, 'jdk', 'temurin-17.0.20+8')
    const jdkBin = join(jdkHome, 'bin')
    const callsPath = join(stubDir, 'calls.jsonl')
    const pnpmStub = join(stubDir, 'pnpm')
    const javaStub = join(stubDir, 'java')
    const asdfStub = join(stubDir, 'asdf')
    writeNativeSpeechRuntime(arm64NativeLibDir)
    writeNativeSpeechRuntime(x86_64NativeLibDir)
    mkdirSync(jdkBin, { recursive: true })
    writeFileSync(join(jdkBin, 'java'), '#!/usr/bin/env sh\nexit 0\n')
    chmodSync(join(jdkBin, 'java'), 0o755)
    writeFileSync(javaStub, '#!/usr/bin/env sh\necho "No version is set for command java" >&2\nexit 126\n')
    chmodSync(javaStub, 0o755)
    writeFileSync(asdfStub, `#!/usr/bin/env node
const command = process.argv[2]
const plugin = process.argv[3]
const version = process.argv[4]
if (command === 'list' && plugin === 'java') {
  process.stdout.write('  temurin-17.0.20+8\\n')
  process.exit(0)
}
if (command === 'where' && plugin === 'java' && version === 'temurin-17.0.20+8') {
  process.stdout.write(${JSON.stringify(jdkHome)} + '\\n')
  process.exit(0)
}
process.exit(1)
`)
    chmodSync(asdfStub, 0o755)
    writeFileSync(pnpmStub, `#!/usr/bin/env node
const fs = require('node:fs')
const path = require('node:path')
const callsPath = ${JSON.stringify(callsPath)}
const argv = process.argv.slice(2)
fs.appendFileSync(callsPath, JSON.stringify({
  argv,
  javaHome: process.env.JAVA_HOME,
  asdfJavaVersion: process.env.ASDF_JAVA_VERSION,
  pathHead: (process.env.PATH || '').split(${JSON.stringify(delimiter)}).slice(0, 2),
  androidNativeTargets: process.env.AURORA_ANDROID_NATIVE_TARGETS,
  arm64NativeLibDir: process.env.AURORA_SHERPA_ONNX_ANDROID_ARM64_V8A_LIB_DIR,
  x86_64NativeLibDir: process.env.AURORA_SHERPA_ONNX_ANDROID_X86_64_LIB_DIR,
}) + '\\n')
if (argv[0] === 'tauri' && argv[1] === 'android' && argv[2] === 'build') {
  const configPath = argv[argv.indexOf('--config') + 1]
  if (!configPath || !fs.existsSync(configPath)) {
    console.error('missing temp config')
    process.exit(2)
  }
  if (configPath.includes(path.join('src-tauri', 'tauri.android-client.conf.json'))) {
    console.error('used source-tree config')
    process.exit(3)
  }
  const config = JSON.parse(fs.readFileSync(configPath, 'utf8'))
  if (JSON.stringify(config.app.security.capabilities) !== JSON.stringify(['aurora-android-thin', 'aurora-mobile-mesh'])) process.exit(4)
  if (config.build.beforeBuildCommand !== null) process.exit(5)
  if (!config.build.frontendDist || !fs.existsSync(config.build.frontendDist)) process.exit(6)
}
if (argv[0] === 'build:frontend:android-client') {
  const dist = path.join(${JSON.stringify(packageRoot)}, 'dist')
  fs.rmSync(dist, { recursive: true, force: true })
  fs.mkdirSync(dist, { recursive: true })
  fs.writeFileSync(path.join(dist, 'index.html'), '<!doctype html><title>Aurora</title>')
}
`)
    chmodSync(pnpmStub, 0o755)

    const result = spawnSync(process.execPath, [buildClient, '--kind', 'aab'], {
      cwd: packageRoot,
      encoding: 'utf8',
      env: androidClientEnv(context, 'aab', {
        PATH: `${stubDir}${delimiter}${process.env.PATH ?? ''}`,
        ASDF_JAVA_VERSION: undefined,
        JAVA_HOME: undefined,
        AURORA_SHERPA_ONNX_ANDROID_ARM64_V8A_LIB_DIR: arm64NativeLibDir,
        AURORA_SHERPA_ONNX_ANDROID_X86_64_LIB_DIR: x86_64NativeLibDir,
        AURORA_TAURI_ANDROID_ALLOWED_REMOTE_ORIGINS: 'https://gateway.example.invalid wss://signaling.example.invalid',
      }),
    })

    expect(result.status, result.stderr).toBe(0)
    const calls = readFileSync(callsPath, 'utf8').trim().split('\n').map((line) => JSON.parse(line))
    expect(calls.map((call) => call.argv.join(' '))).toEqual([
      'build:frontend:android-client',
      'tauri android init --ci --skip-targets-install',
      'android:sync-native-plugin',
      'tauri android build --debug --aab --target aarch64 x86_64 --config ' + calls[3].argv.at(-1),
    ])
    expect(calls[3].argv.at(-1)).not.toContain('src-tauri/tauri.android-client.conf.json')
    expect(calls[3]).toMatchObject({
      javaHome: jdkHome,
      asdfJavaVersion: 'temurin-17.0.20+8',
      androidNativeTargets: 'aarch64,x86_64',
      arm64NativeLibDir,
      x86_64NativeLibDir,
    })
    expect(calls[2]).toMatchObject({
      androidNativeTargets: 'aarch64,x86_64',
      arm64NativeLibDir,
      x86_64NativeLibDir,
    })
    expect(calls[3].pathHead).toEqual([jdkBin, stubDir])
    expect(existsSync(calls[3].argv.at(-1))).toBe(false)
    expect(existsSync(context.configPath)).toBe(false)
    const provenance = JSON.parse(readFileSync(context.aabProvenancePath, 'utf8'))
    expect(provenance).toMatchObject({
      bundleMode: 'android-client',
      kind: 'aab',
      target: 'universal',
      targets: ['aarch64', 'x86_64'],
      sourceConfigWritten: false,
      expectedCapabilities: ['aurora-android-thin', 'aurora-mobile-mesh'],
      nativeSpeechRuntime: {
        abis: ['arm64-v8a', 'x86_64'],
        libraries: requiredNativeSpeechLibraries.slice(1),
        sourceDirectoriesRedacted: true,
      },
    })
    expect(provenance.artifactRoot).toBe(context.buildOutputRoot)
    expect(provenance.config.app.security.capabilities).toEqual([
      'aurora-android-thin',
      'aurora-mobile-mesh',
    ])
    expect(provenance.configSha256).toBe(createHash('sha256').update(`${JSON.stringify(provenance.config, null, 2)}\n`).digest('hex'))
  }, 30_000)

  it('auto-discovers generated universal debug APK and AAB artifacts from nested Tauri output paths', () => {
    const context = createAndroidClientProofContext()
    prepareAndroidClient(context)
    const root = mkdtempSync(join(tmpdir(), 'aurora-android-thin-generated-'))
    const apk = join(root, 'apk', 'universal', 'debug', 'app-universal-debug.apk')
    const aab = join(root, 'bundle', 'universalDebug', 'app-universal-debug.aab')
    writeZip(apk, ['AndroidManifest.xml', 'classes.dex', ...androidNativeLibraryEntries('apk')])
    writeZip(aab, ['base/manifest/AndroidManifest.xml', 'base/dex/classes.dex', ...androidNativeLibraryEntries('aab')])

    const apkResult = runProofAuto(context, 'apk', root)
    const aabResult = runProofAuto(context, 'aab', root)

    expect(apkResult.status, apkResult.stderr).toBe(0)
    expect(aabResult.status, aabResult.stderr).toBe(0)
    expect(readFileSync(context.apkProofPath, 'utf8')).toContain(
      'app-universal-debug.apk',
    )
    expect(readFileSync(context.aabProofPath, 'utf8')).toContain(
      'app-universal-debug.aab',
    )
  })

  it('fails closed when auto-discovery finds ambiguous generated artifacts', () => {
    const context = createAndroidClientProofContext()
    prepareAndroidClient(context)
    const root = mkdtempSync(join(tmpdir(), 'aurora-android-thin-ambiguous-'))
    writeZip(join(root, 'apk', 'universal', 'debug', 'app-universal-debug.apk'), ['AndroidManifest.xml'])
    writeZip(join(root, 'apk', 'universal', 'debug', 'app-copy-universal-debug.apk'), ['AndroidManifest.xml'])

    const result = runProofAuto(context, 'apk', root)

    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('Ambiguous Android client APK artifacts')
  })

  it('fails closed on invalid archives and rejects forbidden Python sidecar entries', () => {
    const context = createAndroidClientProofContext()
    prepareAndroidClient(context)
    const root = mkdtempSync(join(tmpdir(), 'aurora-android-thin-bad-'))
    const broken = join(root, 'broken.apk')
    const forbidden = join(root, 'forbidden.aab')
    writeFileSync(broken, 'not a zip archive\n')
    writeZip(forbidden, ['base/manifest/AndroidManifest.xml', 'base/root/site-packages/pkg/__init__.py', 'base/lib/x86_64/libpython3.11.so', 'base/assets/aurora-sidecar'])

    const brokenResult = runProof(context, 'apk', broken)
    const forbiddenResult = runProof(context, 'aab', forbidden)

    expect(brokenResult.status).not.toBe(0)
    expect(brokenResult.stderr).toContain('failed to inspect APK archive')
    expect(forbiddenResult.status).not.toBe(0)
    expect(forbiddenResult.stderr).toContain('site-packages')
    expect(forbiddenResult.stderr).toContain('libpython')
    expect(forbiddenResult.stderr).toContain('aurora-sidecar')
  })

  it('fails closed when Android native speech libraries or supported AAB ABIs are missing', () => {
    const context = createAndroidClientProofContext()
    prepareAndroidClient(context)
    const root = mkdtempSync(join(tmpdir(), 'aurora-android-native-speech-missing-'))
    const apk = join(root, 'missing-onnxruntime.apk')
    const aab = join(root, 'missing-arm64.aab')
    writeZip(apk, [
      'AndroidManifest.xml',
      'classes.dex',
      'lib/x86_64/libaurora_tauri_lib.so',
      'lib/x86_64/libsherpa-onnx-c-api.so',
    ])
    writeZip(aab, [
      'base/manifest/AndroidManifest.xml',
      'base/dex/classes.dex',
      ...androidNativeLibraryEntries('aab', ['x86_64']),
    ])

    const apkResult = runProof(context, 'apk', apk)
    const aabResult = runProof(context, 'aab', aab)

    expect(apkResult.status).not.toBe(0)
    expect(apkResult.stderr).toContain('lib/x86_64/libonnxruntime.so')
    expect(aabResult.status).not.toBe(0)
    expect(aabResult.stderr).toContain('base/lib/arm64-v8a/libaurora_tauri_lib.so')
    expect(aabResult.stderr).toContain('base/lib/arm64-v8a/libsherpa-onnx-c-api.so')
  })

  it('syncs canonical native plugin before every Android Tauri build script', () => {
    const packageJson = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8')) as { scripts: Record<string, string> }
    const directAndroidBuildScripts = Object.entries(packageJson.scripts)
      .filter(([name, command]) => name.startsWith('android:build:') && command.includes('tauri android build'))
    const clientWrapperScripts = Object.entries(packageJson.scripts)
      .filter(([name]) => name === 'android:build:client:apk' || name === 'android:build:client:aab')
    const thinWrapperScripts = Object.entries(packageJson.scripts)
      .filter(([name]) => name === 'android:build:thin:apk' || name === 'android:build:thin:aab')

    expect(directAndroidBuildScripts.length).toBeGreaterThanOrEqual(5)
    for (const [name, command] of directAndroidBuildScripts) {
      expect(command, `${name} must sync native plugin before compilation`).toMatch(/^pnpm android:sync-native-plugin && pnpm tauri android build/)
    }
    for (const [name, command] of clientWrapperScripts) {
      expect(command, `${name} must use the temp-config build wrapper`).toMatch(/^node \.\/scripts\/build-android-client-bundle\.mjs --kind (apk|aab)$/)
    }
    expect(thinWrapperScripts).toEqual([
      ['android:build:thin:apk', 'pnpm android:build:client:apk'],
      ['android:build:thin:aab', 'pnpm android:build:client:aab'],
    ])
    expect(readFileSync(buildClient, 'utf8')).toContain(
      "run('pnpm', ['android:sync-native-plugin'], nativeSpeechBuild.env)",
    )
    const syncSource = readFileSync(syncNativePlugin, 'utf8')
    expect(syncSource).toContain("resolve('src-tauri/icons/android')")
    expect(syncSource).toContain("resolve('src-tauri/android/aurora-native-plugin/src/main/res')")
    expect(syncSource).toContain('syncCanonicalAndroidLauncherIcons')
    expect(syncSource).toContain('syncAuroraAndroidNativeResources')
    expect(syncSource).toContain('aurora_native_strings.xml')
    expect(syncSource).toContain('repairGeneratedBaseStrings')
    expect(syncSource).toContain('Synced canonical Aurora launcher icons')
    expect(syncSource).toContain('verifyVendorBarcodeScannerSource')
    expect(syncSource).toContain(
      'Verified Android barcode scanner uses Aurora’s cancellation-safe vendored source through the Tauri mobile build output.',
    )
    const cargoToml = readFileSync(
      join(packageRoot, 'src-tauri', 'Cargo.toml'),
      'utf8',
    )
    expect(cargoToml).toContain(
      'tauri-plugin-barcode-scanner = { path = "vendor/tauri-plugin-barcode-scanner" }',
    )
    expect(cargoToml).toContain(
      'aes-gcm = { version = "=0.10.3", default-features = false, features = ["aes", "alloc", "zeroize"] }',
    )
    const barcodeScannerSource = readFileSync(vendorBarcodeScannerSource, 'utf8')
    expect(barcodeScannerSource).toContain('val pendingScan = savedInvoke')
    expect(barcodeScannerSource).toContain('pendingScan?.reject("cancelled")')
    expect(existsSync(join(vendorBarcodeScanner, 'LICENSE_APACHE-2.0'))).toBe(true)
    expect(existsSync(join(vendorBarcodeScanner, 'LICENSE_MIT'))).toBe(true)
    for (const permission of [
      'android.permission.RECORD_AUDIO',
      'android.permission.MODIFY_AUDIO_SETTINGS',
      'android.permission.POST_NOTIFICATIONS',
      'android.permission.FOREGROUND_SERVICE',
      'android.permission.FOREGROUND_SERVICE_MICROPHONE',
      'android.permission.WAKE_LOCK',
      'android.permission.ACCESS_NETWORK_STATE',
      'android.permission.USE_BIOMETRIC',
    ]) {
      expect(syncSource).toContain(permission)
    }
    for (const component of [
      'AuroraVoiceForegroundService',
      'AuroraVoiceInteractionService',
      'AuroraVoiceInteractionSessionService',
      'AuroraAssistActivity',
      'AuroraEntrypointActivity',
      'AuroraWidgetProvider',
      'AuroraQuickSettingsTileService',
    ]) {
      expect(syncSource).toContain(component)
    }
    for (const resource of [
      'drawable/ic_aurora_entrypoint.xml',
      'layout/aurora_widget.xml',
      'xml/aurora_shortcuts.xml',
      'xml/aurora_network_security_config.xml',
      'xml/aurora_voice_interaction_service.xml',
      'xml/aurora_widget_info.xml',
    ]) {
      expect(existsSync(join(canonicalPluginResources, resource))).toBe(true)
    }
    expect(readFileSync(buildClient, 'utf8')).toContain('cleanAndroidBuildOutputs')
  })

  it('syncs init-time Android projects before Tauri writes mobile Gradle plugin files', () => {
    const root = mkdtempSync(join(tmpdir(), 'aurora-android-init-sync-'))
    const arm64NativeLibDir = join(root, 'native-source', 'arm64-v8a')
    const x86_64NativeLibDir = join(root, 'native-source', 'x86_64')
    const manifestPath = join(root, 'app', 'src', 'main', 'AndroidManifest.xml')
    const mainActivityPath = join(
      root,
      'app',
      'src',
      'main',
      'java',
      'dev',
      'aurora',
      'desktop',
      'MainActivity.kt',
    )
    const reportPath = join(root, 'android-preflight.json')
    writeNativeSpeechRuntime(arm64NativeLibDir)
    writeNativeSpeechRuntime(x86_64NativeLibDir)
    mkdirSync(dirname(manifestPath), { recursive: true })
    mkdirSync(dirname(mainActivityPath), { recursive: true })
    writeFileSync(
      manifestPath,
      [
        '<manifest xmlns:android="http://schemas.android.com/apk/res/android">',
        '<uses-permission android:name="android.permission.INTERNET" />',
        '<application android:usesCleartextTraffic="false">',
        '<activity android:name=".MainActivity"></activity>',
        '</application>',
        '</manifest>',
      ].join(''),
    )
    writeFileSync(
      mainActivityPath,
      [
        'package dev.aurora.desktop',
        '',
        'import android.os.Bundle',
        'import androidx.activity.enableEdgeToEdge',
        '',
        'class MainActivity : TauriActivity() {',
        '  override fun onCreate(savedInstanceState: Bundle?) {',
        '    enableEdgeToEdge()',
        '    super.onCreate(savedInstanceState)',
        '  }',
        '}',
        '',
      ].join('\n'),
    )

    const syncResult = spawnSync(process.execPath, [syncNativePlugin], {
      cwd: packageRoot,
      encoding: 'utf8',
      env: {
        ...process.env,
        AURORA_ANDROID_GENERATED_PROJECT_DIR: root,
        AURORA_ANDROID_NATIVE_TARGETS: 'aarch64,x86_64',
        AURORA_SHERPA_ONNX_ANDROID_ARM64_V8A_LIB_DIR: arm64NativeLibDir,
        AURORA_SHERPA_ONNX_ANDROID_X86_64_LIB_DIR: x86_64NativeLibDir,
      },
    })

    expect(syncResult.status, syncResult.stderr).toBe(0)
    expect(syncResult.stdout).toContain(
      'Verified Android barcode scanner uses Aurora’s cancellation-safe vendored source',
    )
    expect(syncResult.stdout).toContain(
      'Staged Android native speech runtime libraries for arm64-v8a, x86_64',
    )
    for (const [abi, sourceDir] of [
      ['arm64-v8a', arm64NativeLibDir],
      ['x86_64', x86_64NativeLibDir],
    ]) {
      for (const library of requiredNativeSpeechLibraries.slice(1)) {
        expect(
          readFileSync(join(root, 'app', 'src', 'main', 'jniLibs', abi, library), 'utf8'),
        ).toBe(readFileSync(join(sourceDir, library), 'utf8'))
      }
    }
    expect(readFileSync(manifestPath, 'utf8')).toMatch(
      /<activity\b(?=[^>]*android:name="\.MainActivity")(?=[^>]*android:windowSoftInputMode="adjustResize")[^>]*>/,
    )
    const mainActivity = readFileSync(mainActivityPath, 'utf8')
    expect(mainActivity).toContain('ViewCompat.setOnApplyWindowInsetsListener(content)')
    expect(mainActivity).toContain('WindowInsetsCompat.Type.ime()')
    expect(mainActivity).toContain('applyAuroraImeInsets()')
    expect(existsSync(join(root, 'tauri.settings.gradle'))).toBe(false)
    expect(existsSync(join(root, 'app', 'tauri.build.gradle.kts'))).toBe(false)
    expect(
      existsSync(
        join(
          root,
          'app',
          'src',
          'main',
          'java',
          'dev',
          'aurora',
          'tauri',
          'nativeplugin',
          'AuroraNativePlugin.kt',
        ),
      ),
    ).toBe(true)

    writeFileSync(
      join(x86_64NativeLibDir, 'libsherpa-onnx-c-api.so'),
      'TTS is not enabled. Please rebuild sherpa-onnx\n',
    )
    const ttsDisabledResult = spawnSync(process.execPath, [syncNativePlugin], {
      cwd: packageRoot,
      encoding: 'utf8',
      env: {
        ...process.env,
        AURORA_ANDROID_GENERATED_PROJECT_DIR: root,
        AURORA_ANDROID_NATIVE_TARGETS: 'aarch64,x86_64',
        AURORA_SHERPA_ONNX_ANDROID_ARM64_V8A_LIB_DIR: arm64NativeLibDir,
        AURORA_SHERPA_ONNX_ANDROID_X86_64_LIB_DIR: x86_64NativeLibDir,
      },
    })
    expect(ttsDisabledResult.status).not.toBe(0)
    expect(ttsDisabledResult.stderr).toContain(
      'SHERPA_ONNX_ENABLE_TTS=ON',
    )

    const preflightResult = spawnSync(
      process.execPath,
      [androidPreflight, '--require-android-project'],
      {
        cwd: packageRoot,
        encoding: 'utf8',
        env: {
          ...process.env,
          AURORA_ANDROID_GENERATED_PROJECT_DIR: root,
          AURORA_ANDROID_PREFLIGHT_REPORT: reportPath,
        },
      },
    )

    expect(preflightResult.status, preflightResult.stderr).toBe(0)
    const report = JSON.parse(readFileSync(reportPath, 'utf8'))
    expect(report.barcodeScannerCancellation).toMatchObject({
      checked: true,
      settings: null,
      settingsUseVendor: null,
      dependencyUsesVendor: true,
      buildScriptUsesAndroidPath: true,
      matched: true,
    })
  })

  it('fails Android preflight when generated native plugin source differs from canonical source', () => {
    const root = mkdtempSync(join(tmpdir(), 'aurora-android-plugin-mismatch-'))
    const reportPath = join(root, 'android-preflight.json')
    const generatedPluginSource = join(root, 'app', 'src', 'main', 'java', 'dev', 'aurora', 'tauri', 'nativeplugin')
    cpSync(canonicalPluginSource, generatedPluginSource, { recursive: true })
    writeFileSync(join(generatedPluginSource, 'AuroraNativePlugin.kt'), `${readFileSync(join(generatedPluginSource, 'AuroraNativePlugin.kt'), 'utf8')}\n// stale generated copy regression marker\n`)

    const result = spawnSync(process.execPath, [androidPreflight, '--require-android-project'], {
      cwd: packageRoot,
      encoding: 'utf8',
      env: {
        ...process.env,
        AURORA_ANDROID_GENERATED_PROJECT_DIR: root,
        AURORA_ANDROID_PREFLIGHT_REPORT: reportPath,
      },
    })

    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('android-native-plugin-parity')
    const report = JSON.parse(readFileSync(reportPath, 'utf8'))
    expect(report.nativePluginParity.mismatched).toContain('AuroraNativePlugin.kt')
  })

  it('documents Android client scripts as Python-free and CI-verifiable', () => {
    const packageJson = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8')) as { scripts: Record<string, string> }
    expect(packageJson.scripts['android:prepare:client']).toBe('node ./scripts/prepare-android-client-bundle.mjs')
    expect(packageJson.scripts['android:prepare:thin']).toBe('pnpm android:prepare:client')
    expect(packageJson.scripts['android:sync-native-plugin']).toBe('node ./scripts/install-android-native-plugin.mjs')
    expect(packageJson.scripts['android:init']).toContain('android:sync-native-plugin')
    expect(packageJson.scripts['android:preflight']).toContain('android:sync-native-plugin')
    expect(packageJson.scripts['android:preflight:ci']).toContain('android:sync-native-plugin')
    expect(packageJson.scripts['android:preflight:strict']).toContain('android:sync-native-plugin')
    expect(packageJson.scripts['android:build:client:apk']).toBe('node ./scripts/build-android-client-bundle.mjs --kind apk')
    expect(packageJson.scripts['android:build:voice-live:apk']).toBe(
      'node ./scripts/build-android-client-bundle.mjs --kind apk --voice-live-test',
    )
    expect(packageJson.scripts['android:build:thin:apk']).toBe('pnpm android:build:client:apk')
    expect(packageJson.scripts['android:build:client:apk:arm64']).toBe(
      'node ./scripts/build-android-client-bundle.mjs --kind apk --target aarch64',
    )
    expect(packageJson.scripts['android:build:thin:apk:arm64']).toBe('pnpm android:build:client:apk:arm64')
    expect(packageJson.scripts['android:build:client:apk:x86_64']).toBe(
      'node ./scripts/build-android-client-bundle.mjs --kind apk --target x86_64',
    )
    expect(packageJson.scripts['android:build:thin:apk:x86_64']).toBe('pnpm android:build:client:apk:x86_64')
    expect(packageJson.scripts['android:build:client:aab']).toBe('node ./scripts/build-android-client-bundle.mjs --kind aab')
    expect(packageJson.scripts['android:build:thin:aab']).toBe('pnpm android:build:client:aab')
    const buildSource = readFileSync(buildClient, 'utf8')
    expect(buildSource).toContain('AURORA_TAURI_ANDROID_CLIENT_CONFIG_PATH')
    expect(buildSource).toContain('android-client-${kind}-build-provenance.json')
    expect(buildSource).toContain("run('pnpm', ['tauri', 'android', 'init', '--ci', '--skip-targets-install'])")
    expect(buildSource).toContain("const target = readOption('--target')")
    expect(buildSource).toContain("const voiceLiveTest = args.includes('--voice-live-test')")
    expect(buildSource).toContain('AURORA_TAURI_ANDROID_VOICE_LIVE_TEST: voiceLiveTest')
    expect(buildSource).toContain("target: target ?? 'universal'")
    expect(buildSource).toContain("const defaultAndroidTargets = ['aarch64', 'x86_64']")
    expect(buildSource).toContain("buildArgs.push('--target', ...targets)")
    expect(buildSource).toContain('AURORA_SHERPA_ONNX_ANDROID_ARM64_V8A_LIB_DIR')
    expect(buildSource).toContain('AURORA_SHERPA_ONNX_ANDROID_X86_64_LIB_DIR')
    expect(packageJson.scripts['android:verify:client:apk']).toContain('assert-android-client-artifact-clean.mjs --kind apk')
    expect(packageJson.scripts['android:verify:thin:apk']).toBe('pnpm android:verify:client:apk')
    expect(packageJson.scripts['android:verify:client:aab']).toContain('assert-android-client-artifact-clean.mjs --kind aab')
    expect(packageJson.scripts['android:verify:thin:aab']).toBe('pnpm android:verify:client:aab')
    for (const [name, command] of Object.entries(packageJson.scripts)) {
      if (!name.includes(':client') && !name.includes(':thin')) continue
      expect(command, `${name} must be Python-free`).not.toMatch(/prepare-sidecar|\bpython\b|\buv\b/i)
    }
    for (const [name, command] of Object.entries(packageJson.scripts)) {
      if (!name.includes(':client')) continue
      expect(command, `${name} must not compile a thin role`).not.toMatch(
        /THIN|android-thin|VITE_AURORA_RUNTIME_MODE|WEBRTC_THIN_CLIENT/,
      )
    }
  })

  it('keeps Android client cleartext fail-closed outside loopback', () => {
    const manifest = readFileSync(
      join(
        packageRoot,
        'src-tauri',
        'android',
        'aurora-native-plugin',
        'src',
        'main',
        'AndroidManifest.xml',
      ),
      'utf8',
    )

    const networkSecurity = readFileSync(
      join(
        packageRoot,
        'src-tauri',
        'android',
        'aurora-native-plugin',
        'src',
        'main',
        'res',
        'xml',
        'aurora_network_security_config.xml',
      ),
      'utf8',
    )

    expect(manifest).toContain('android:usesCleartextTraffic="false"')
    expect(manifest).toContain('android:networkSecurityConfig="@xml/aurora_network_security_config"')
    expect(manifest).toContain('android.software.webview')
    expect(networkSecurity).toContain('<base-config cleartextTrafficPermitted="false" />')
    expect(networkSecurity).toContain('<domain includeSubdomains="false">localhost</domain>')
    expect(networkSecurity).toContain('<domain includeSubdomains="false">127.0.0.1</domain>')
    const syncScript = readFileSync(syncNativePlugin, 'utf8')
    expect(syncScript).toContain('android.software.webview')
    expect(syncScript).toContain('android:usesCleartextTraffic="false"')
    expect(syncScript).toContain('android:networkSecurityConfig="@xml/aurora_network_security_config"')
  })
})

function writeZip(path: string, names: string[]) {
  const localParts: Buffer[] = []
  const centralParts: Buffer[] = []
  let offset = 0
  for (const name of names) {
    const nameBuffer = Buffer.from(name)
    const local = Buffer.alloc(30 + nameBuffer.length)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(0, 6)
    local.writeUInt16LE(0, 8)
    local.writeUInt32LE(0, 14)
    local.writeUInt32LE(0, 18)
    local.writeUInt32LE(0, 22)
    local.writeUInt16LE(nameBuffer.length, 26)
    nameBuffer.copy(local, 30)
    localParts.push(local)

    const central = Buffer.alloc(46 + nameBuffer.length)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(20, 4)
    central.writeUInt16LE(20, 6)
    central.writeUInt16LE(0, 8)
    central.writeUInt16LE(0, 10)
    central.writeUInt32LE(0, 16)
    central.writeUInt32LE(0, 20)
    central.writeUInt32LE(0, 24)
    central.writeUInt16LE(nameBuffer.length, 28)
    central.writeUInt32LE(offset, 42)
    nameBuffer.copy(central, 46)
    centralParts.push(central)
    offset += local.length
  }
  const centralOffset = offset
  const centralSize = centralParts.reduce((sum, part) => sum + part.length, 0)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(names.length, 8)
  eocd.writeUInt16LE(names.length, 10)
  eocd.writeUInt32LE(centralSize, 12)
  eocd.writeUInt32LE(centralOffset, 16)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, Buffer.concat([...localParts, ...centralParts, eocd]))
}
