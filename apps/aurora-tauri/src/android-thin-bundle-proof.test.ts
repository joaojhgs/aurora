// @vitest-environment node

import { execFileSync, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const prepare = join(packageRoot, 'scripts', 'prepare-android-thin-bundle.mjs')
const buildThin = join(packageRoot, 'scripts', 'build-android-thin-bundle.mjs')
const proof = join(packageRoot, 'scripts', 'assert-android-thin-artifact-clean.mjs')
const buildFrontend = join(packageRoot, 'scripts', 'build-android-thin-frontend.mjs')
const androidPreflight = join(packageRoot, 'scripts', 'android-preflight.mjs')
const canonicalPluginSource = join(packageRoot, 'src-tauri', 'android', 'aurora-native-plugin', 'src', 'main', 'java', 'dev', 'aurora', 'tauri', 'nativeplugin')

type AndroidThinKind = 'apk' | 'aab'

interface AndroidThinProofContext {
  root: string
  configPath: string
  prepareReportPath: string
  apkProvenancePath: string
  aabProvenancePath: string
  apkProofPath: string
  aabProofPath: string
}

function createAndroidThinProofContext(): AndroidThinProofContext {
  const root = mkdtempSync(join(tmpdir(), 'aurora-android-thin-proof-'))
  return {
    root,
    configPath: join(root, 'tauri.android-thin.conf.json'),
    prepareReportPath: join(root, 'android-thin-bundle-prepare.json'),
    apkProvenancePath: join(root, 'android-thin-apk-build-provenance.json'),
    aabProvenancePath: join(root, 'android-thin-aab-build-provenance.json'),
    apkProofPath: join(root, 'android-thin-apk-artifact-proof.json'),
    aabProofPath: join(root, 'android-thin-aab-artifact-proof.json'),
  }
}

function androidThinEnv(
  context: AndroidThinProofContext,
  kind: AndroidThinKind = 'apk',
  extra: NodeJS.ProcessEnv = {},
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    AURORA_TAURI_ANDROID_THIN_CONFIG_PATH: context.configPath,
    AURORA_TAURI_ANDROID_THIN_SOURCE_CONFIG_PATH: context.configPath,
    AURORA_TAURI_ANDROID_THIN_REPORT_PATH: context.prepareReportPath,
    AURORA_TAURI_ANDROID_THIN_BUILD_PROVENANCE_PATH:
      kind === 'apk' ? context.apkProvenancePath : context.aabProvenancePath,
    AURORA_TAURI_ANDROID_THIN_PROOF_REPORT_PATH:
      kind === 'apk' ? context.apkProofPath : context.aabProofPath,
    ...extra,
  }
  for (const [name, value] of Object.entries(env)) {
    if (value === undefined) delete env[name]
  }
  return env
}

function prepareAndroidThin(
  context: AndroidThinProofContext,
  origins = 'https://gateway.example.invalid wss://signaling.example.invalid',
  connectionMode?: string,
) {
  execFileSync(process.execPath, [prepare], {
    cwd: packageRoot,
    env: androidThinEnv(context, 'apk', {
      AURORA_TAURI_ANDROID_ALLOWED_REMOTE_ORIGINS: origins,
      AURORA_TAURI_THIN_CONNECTION_MODE: connectionMode,
    }),
  })
}

function runProof(
  context: AndroidThinProofContext,
  kind: AndroidThinKind,
  artifact: string,
) {
  return spawnSync(process.execPath, [proof, '--kind', kind, '--artifact', artifact], {
    cwd: packageRoot,
    encoding: 'utf8',
    env: androidThinEnv(context, kind),
  })
}

function runProofAuto(
  context: AndroidThinProofContext,
  kind: AndroidThinKind,
  artifactRoot: string,
) {
  return spawnSync(process.execPath, [proof, '--kind', kind], {
    cwd: packageRoot,
    encoding: 'utf8',
    env: androidThinEnv(context, kind, {
      AURORA_ANDROID_THIN_ARTIFACT_DIR: artifactRoot,
    }),
  })
}

const describeIfNode = typeof window === 'undefined' ? describe : describe.skip

describeIfNode('Android-thin bundle artifact proof', () => {
  it('prepares a Python-free Android thin overlay with exact HTTPS/WSS root origins', () => {
    const context = createAndroidThinProofContext()
    prepareAndroidThin(
      context,
      'https://gateway.example.invalid wss://signaling.example.invalid',
    )

    const config = readFileSync(context.configPath, 'utf8')
    const report = readFileSync(context.prepareReportPath, 'utf8')

    expect(config).toContain('aurora-android-thin')
    expect(config).toContain('https://gateway.example.invalid')
    expect(config).toContain('wss://signaling.example.invalid')
    expect(config).toContain('"externalBin": []')
    expect(config).toContain('"resources": {}')
    expect(config).not.toMatch(/aurora-sidecar|prepare-sidecar|config_defaults\.json|site-packages|\.venv/i)
    expect(report).toContain('"pythonSidecarStaged": false')
  })

  it('prepares a WebRTC-only Android package without an HTTP Gateway origin', () => {
    const context = createAndroidThinProofContext()
    prepareAndroidThin(
      context,
      'https://unused-gateway.example.invalid wss://signaling.example.invalid',
      'webrtc-only',
    )

    const config = JSON.parse(readFileSync(context.configPath, 'utf8'))
    const report = JSON.parse(readFileSync(context.prepareReportPath, 'utf8'))
    expect(config.app.security.csp).toContain(
      "connect-src 'self' wss://signaling.example.invalid",
    )
    expect(config.app.security.csp).not.toContain('https://')
    expect(report).toMatchObject({
      connectionMode: 'webrtc-only',
      gatewayOrigin: null,
      signalingOrigin: 'wss://signaling.example.invalid',
    })
  })

  it('rejects missing, scheme-wide, wildcard, insecure, credentialed, path, query, and fragment origins', () => {
    for (const value of [
      '',
      'https:',
      'wss:',
      'https://*.example.invalid',
      'http://gateway.example.invalid',
      'ws://signaling.example.invalid',
      'https://user:pass@gateway.example.invalid',
      'https://gateway.example.invalid/api',
      'https://gateway.example.invalid?token=secret',
      'wss://signaling.example.invalid#invite'
    ]) {
      const result = spawnSync(process.execPath, [prepare], {
        cwd: packageRoot,
        encoding: 'utf8',
        env: androidThinEnv(createAndroidThinProofContext(), 'apk', {
          AURORA_TAURI_ANDROID_ALLOWED_REMOTE_ORIGINS: value,
        }),
      })
      expect(result.status, value || '<empty>').not.toBe(0)
    }
  })

  it.each(['webrtc-only', 'webrtc-preferred'])(
    'requires WSS signaling for %s even when multiple HTTPS origins are present',
    (connectionMode) => {
      const result = spawnSync(process.execPath, [prepare], {
        cwd: packageRoot,
        encoding: 'utf8',
        env: androidThinEnv(createAndroidThinProofContext(), 'apk', {
          AURORA_TAURI_ANDROID_ALLOWED_REMOTE_ORIGINS:
            'https://gateway.example.invalid https://not-signaling.example.invalid',
          AURORA_TAURI_THIN_CONNECTION_MODE: connectionMode,
        }),
      })

      expect(result.status).not.toBe(0)
      expect(result.stderr).toContain(
        `${connectionMode} requires an exact WSS signaling origin.`,
      )
    },
  )

  it('applies the same exact-origin validation before Android-thin frontend builds', () => {
    for (const value of [
      'https://*.example.invalid',
      'http://gateway.example.invalid',
      'https://user:pass@gateway.example.invalid',
      'https://gateway.example.invalid/api',
      'https://gateway.example.invalid?token=secret',
      'wss://signaling.example.invalid#invite'
    ]) {
      const result = spawnSync(process.execPath, [buildFrontend], {
        cwd: packageRoot,
        encoding: 'utf8',
        env: { ...process.env, AURORA_TAURI_ANDROID_ALLOWED_REMOTE_ORIGINS: value }
      })
      expect(result.status, value).not.toBe(0)
    }

    for (const connectionMode of ['webrtc-only', 'webrtc-preferred']) {
      const result = spawnSync(process.execPath, [buildFrontend], {
        cwd: packageRoot,
        encoding: 'utf8',
        env: {
          ...process.env,
          AURORA_TAURI_ANDROID_ALLOWED_REMOTE_ORIGINS:
            'https://gateway.example.invalid https://not-signaling.example.invalid',
          AURORA_TAURI_THIN_CONNECTION_MODE: connectionMode,
        },
      })
      expect(result.status, connectionMode).not.toBe(0)
      expect(result.stderr).toContain(
        `${connectionMode} requires an exact WSS signaling origin.`,
      )
    }

    const stubDir = mkdtempSync(join(tmpdir(), 'aurora-android-thin-pnpm-'))
    const envPath = join(stubDir, 'frontend-env.json')
    const pnpmStub = join(stubDir, 'pnpm')
    writeFileSync(pnpmStub, `#!/usr/bin/env node\nconst fs = require('node:fs')\nfs.writeFileSync(${JSON.stringify(envPath)}, JSON.stringify({ argv: process.argv.slice(2), gateway: process.env.VITE_AURORA_GATEWAY_URL, signaling: process.env.VITE_AURORA_SIGNALING_URL, connectionMode: process.env.VITE_AURORA_CONNECTION_MODE, mode: process.env.VITE_AURORA_RUNTIME_MODE }, null, 2))\n`)
    chmodSync(pnpmStub, 0o755)

    const ok = spawnSync(process.execPath, [buildFrontend], {
      cwd: packageRoot,
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${stubDir}${delimiter}${process.env.PATH ?? ''}`,
        AURORA_TAURI_ANDROID_ALLOWED_REMOTE_ORIGINS: 'https://gateway.example.invalid/ wss://signaling.example.invalid'
      }
    })

    expect(ok.status, ok.stderr).toBe(0)
    const frontendEnv = JSON.parse(readFileSync(envPath, 'utf8'))
    expect(frontendEnv).toMatchObject({
      argv: ['build'],
      gateway: 'https://gateway.example.invalid',
      signaling: 'wss://signaling.example.invalid',
      connectionMode: 'webrtc-preferred',
      mode: 'android-thin'
    })

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
      signaling: 'wss://signaling.example.invalid',
      connectionMode: 'webrtc-only',
      mode: 'android-thin',
    })
  })

  it('passes on minimal APK and AAB archives without Python or sidecar entries', () => {
    const context = createAndroidThinProofContext()
    prepareAndroidThin(context)
    const root = mkdtempSync(join(tmpdir(), 'aurora-android-thin-clean-'))
    const apk = join(root, 'app-x86_64-debug.apk')
    const aab = join(root, 'app-debug.aab')
    writeZip(apk, ['AndroidManifest.xml', 'classes.dex', 'lib/x86_64/libaurora_tauri.so'])
    writeZip(aab, ['base/manifest/AndroidManifest.xml', 'base/dex/classes.dex', 'base/lib/x86_64/libaurora_tauri.so'])

    const apkResult = runProof(context, 'apk', apk)
    const aabResult = runProof(context, 'aab', aab)

    expect(apkResult.status, apkResult.stderr).toBe(0)
    expect(aabResult.status, aabResult.stderr).toBe(0)
    expect(apkResult.stdout).toContain('Android-thin APK artifact proof passed')
    expect(aabResult.stdout).toContain('Android-thin AAB artifact proof passed')
  })

  it('verifies from build provenance when the source-tree Android thin config is absent', () => {
    const context = createAndroidThinProofContext()
    prepareAndroidThin(context)
    const configRaw = readFileSync(context.configPath, 'utf8')
    const config = JSON.parse(configRaw)
    writeFileSync(context.apkProvenancePath, `${JSON.stringify({
      generatedAt: new Date().toISOString(),
      bundleMode: 'android-thin',
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
    writeZip(apk, ['AndroidManifest.xml', 'classes.dex', 'lib/x86_64/libaurora_tauri.so'])

    const result = runProof(context, 'apk', apk)

    expect(result.status, result.stderr).toBe(0)
    expect(readFileSync(context.apkProofPath, 'utf8')).toContain(
      '"configSource": "build-provenance"',
    )
    expect(existsSync(context.configPath)).toBe(false)
  })

  it('builds Android-thin bundles through a temp config and records reusable provenance', () => {
    const context = createAndroidThinProofContext()
    const stubDir = mkdtempSync(join(tmpdir(), 'aurora-android-thin-build-pnpm-'))
    const callsPath = join(stubDir, 'calls.jsonl')
    const pnpmStub = join(stubDir, 'pnpm')
    writeFileSync(pnpmStub, `#!/usr/bin/env node
const fs = require('node:fs')
const path = require('node:path')
const callsPath = ${JSON.stringify(callsPath)}
const argv = process.argv.slice(2)
fs.appendFileSync(callsPath, JSON.stringify({ argv }) + '\\n')
if (argv[0] === 'tauri' && argv[1] === 'android' && argv[2] === 'build') {
  const configPath = argv[argv.indexOf('--config') + 1]
  if (!configPath || !fs.existsSync(configPath)) {
    console.error('missing temp config')
    process.exit(2)
  }
  if (configPath.includes(path.join('src-tauri', 'tauri.android-thin.conf.json'))) {
    console.error('used source-tree config')
    process.exit(3)
  }
  const config = JSON.parse(fs.readFileSync(configPath, 'utf8'))
  if (config.app.security.capabilities[0] !== 'aurora-android-thin') process.exit(4)
}
`)
    chmodSync(pnpmStub, 0o755)

    const result = spawnSync(process.execPath, [buildThin, '--kind', 'aab'], {
      cwd: packageRoot,
      encoding: 'utf8',
      env: androidThinEnv(context, 'aab', {
        PATH: `${stubDir}${delimiter}${process.env.PATH ?? ''}`,
        AURORA_TAURI_ANDROID_ALLOWED_REMOTE_ORIGINS: 'https://gateway.example.invalid wss://signaling.example.invalid',
      }),
    })

    expect(result.status, result.stderr).toBe(0)
    const calls = readFileSync(callsPath, 'utf8').trim().split('\n').map((line) => JSON.parse(line))
    expect(calls.map((call) => call.argv.join(' '))).toEqual([
      'android:sync-native-plugin',
      'tauri android build --debug --aab --config ' + calls[1].argv.at(-1),
    ])
    expect(calls[1].argv.at(-1)).not.toContain('src-tauri/tauri.android-thin.conf.json')
    expect(existsSync(calls[1].argv.at(-1))).toBe(false)
    expect(existsSync(context.configPath)).toBe(false)
    const provenance = JSON.parse(readFileSync(context.aabProvenancePath, 'utf8'))
    expect(provenance).toMatchObject({ bundleMode: 'android-thin', kind: 'aab', sourceConfigWritten: false, expectedCapability: 'aurora-android-thin' })
    expect(provenance.config.app.security.capabilities).toEqual(['aurora-android-thin'])
    expect(provenance.configSha256).toBe(createHash('sha256').update(`${JSON.stringify(provenance.config, null, 2)}\n`).digest('hex'))
  })

  it('auto-discovers generated universal debug APK and AAB artifacts from nested Tauri output paths', () => {
    const context = createAndroidThinProofContext()
    prepareAndroidThin(context)
    const root = mkdtempSync(join(tmpdir(), 'aurora-android-thin-generated-'))
    const apk = join(root, 'apk', 'universal', 'debug', 'app-universal-debug.apk')
    const aab = join(root, 'bundle', 'universalDebug', 'app-universal-debug.aab')
    writeZip(apk, ['AndroidManifest.xml', 'classes.dex', 'lib/x86_64/libaurora_tauri.so'])
    writeZip(aab, ['base/manifest/AndroidManifest.xml', 'base/dex/classes.dex', 'base/lib/x86_64/libaurora_tauri.so'])

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
    const context = createAndroidThinProofContext()
    prepareAndroidThin(context)
    const root = mkdtempSync(join(tmpdir(), 'aurora-android-thin-ambiguous-'))
    writeZip(join(root, 'apk', 'universal', 'debug', 'app-universal-debug.apk'), ['AndroidManifest.xml'])
    writeZip(join(root, 'apk', 'universal', 'debug', 'app-copy-universal-debug.apk'), ['AndroidManifest.xml'])

    const result = runProofAuto(context, 'apk', root)

    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('Ambiguous Android-thin APK artifacts')
  })

  it('fails closed on invalid archives and rejects forbidden Python sidecar entries', () => {
    const context = createAndroidThinProofContext()
    prepareAndroidThin(context)
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

  it('syncs canonical native plugin before every Android Tauri build script', () => {
    const packageJson = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8')) as { scripts: Record<string, string> }
    const directAndroidBuildScripts = Object.entries(packageJson.scripts)
      .filter(([name, command]) => name.startsWith('android:build:') && command.includes('tauri android build'))
    const thinWrapperScripts = Object.entries(packageJson.scripts)
      .filter(([name]) => name === 'android:build:thin:apk' || name === 'android:build:thin:aab')

    expect(directAndroidBuildScripts.length).toBeGreaterThanOrEqual(5)
    for (const [name, command] of directAndroidBuildScripts) {
      expect(command, `${name} must sync native plugin before compilation`).toMatch(/^pnpm android:sync-native-plugin && pnpm tauri android build/)
    }
    for (const [name, command] of thinWrapperScripts) {
      expect(command, `${name} must use the temp-config build wrapper`).toMatch(/^node \.\/scripts\/build-android-thin-bundle\.mjs --kind (apk|aab)$/)
    }
    expect(readFileSync(buildThin, 'utf8')).toContain("run('pnpm', ['android:sync-native-plugin'])")
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

  it('documents Android thin scripts as Python-free and CI-verifiable', () => {
    const packageJson = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8')) as { scripts: Record<string, string> }
    expect(packageJson.scripts['android:prepare:thin']).toBe('node ./scripts/prepare-android-thin-bundle.mjs')
    expect(packageJson.scripts['android:sync-native-plugin']).toBe('node ./scripts/install-android-native-plugin.mjs')
    expect(packageJson.scripts['android:init']).toContain('android:sync-native-plugin')
    expect(packageJson.scripts['android:preflight']).toContain('android:sync-native-plugin')
    expect(packageJson.scripts['android:preflight:ci']).toContain('android:sync-native-plugin')
    expect(packageJson.scripts['android:preflight:strict']).toContain('android:sync-native-plugin')
    expect(packageJson.scripts['android:build:thin:apk']).toBe('node ./scripts/build-android-thin-bundle.mjs --kind apk')
    expect(packageJson.scripts['android:build:thin:aab']).toBe('node ./scripts/build-android-thin-bundle.mjs --kind aab')
    expect(readFileSync(buildThin, 'utf8')).toContain('AURORA_TAURI_ANDROID_THIN_CONFIG_PATH')
    expect(readFileSync(buildThin, 'utf8')).toContain('android-thin-${kind}-build-provenance.json')
    expect(packageJson.scripts['android:verify:thin:apk']).toContain('assert-android-thin-artifact-clean.mjs --kind apk')
    expect(packageJson.scripts['android:verify:thin:aab']).toContain('assert-android-thin-artifact-clean.mjs --kind aab')
    for (const [name, command] of Object.entries(packageJson.scripts)) {
      if (!name.includes(':thin')) continue
      expect(command, `${name} must be Python-free`).not.toMatch(/prepare-sidecar|\bpython\b|\buv\b/i)
    }
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
