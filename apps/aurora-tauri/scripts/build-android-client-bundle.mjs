#!/usr/bin/env node
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { delimiter, dirname, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const repoRoot = resolve(packageRoot, '..', '..')
const srcTauriRoot = join(packageRoot, 'src-tauri')
const artifactOutputRoot = resolve(
  process.env.AURORA_TAURI_ANDROID_BUILD_OUTPUT_ROOT
    ?? join(
      srcTauriRoot,
      'gen',
      'android',
      'app',
      'build',
      'outputs',
    ),
)
const sourceConfigPath = resolve(
  process.env.AURORA_TAURI_ANDROID_CLIENT_SOURCE_CONFIG_PATH
    ?? process.env.AURORA_TAURI_ANDROID_THIN_SOURCE_CONFIG_PATH
    ?? join(srcTauriRoot, 'tauri.android-client.conf.json'),
)
const prepareScript = join(packageRoot, 'scripts', 'prepare-android-client-bundle.mjs')
const androidTargetSpecs = {
  aarch64: {
    abi: 'arm64-v8a',
    libDirEnv: 'AURORA_SHERPA_ONNX_ANDROID_ARM64_V8A_LIB_DIR',
  },
  x86_64: {
    abi: 'x86_64',
    libDirEnv: 'AURORA_SHERPA_ONNX_ANDROID_X86_64_LIB_DIR',
  },
}
const defaultAndroidTargets = ['aarch64', 'x86_64']
const requiredNativeSpeechLibraries = [
  'libonnxruntime.so',
  'libsherpa-onnx-c-api.so',
]

const args = process.argv.slice(2)
const kind = readOption('--kind') ?? (args.includes('--aab') ? 'aab' : args.includes('--apk') ? 'apk' : 'apk')
const target = readOption('--target')
const voiceLiveTest = args.includes('--voice-live-test')
if (!['apk', 'aab'].includes(kind)) {
  throw new Error(`--kind must be apk or aab, got ${kind}`)
}
const targets = target ? [target] : defaultAndroidTargets
const nativeSpeechBuild = resolveNativeSpeechBuild(process.env, targets)

const tempDir = mkdtempSync(join(tmpdir(), `aurora-android-client-${kind}-`))
const tempConfigPath = join(tempDir, 'tauri.android-client.conf.json')
const tempPrepareReportPath = join(tempDir, 'android-client-bundle-prepare.json')
const tempFrontendDist = join(tempDir, 'dist')
const buildProvenancePath = resolve(
  process.env.AURORA_TAURI_ANDROID_CLIENT_BUILD_PROVENANCE_PATH
    ?? process.env.AURORA_TAURI_ANDROID_THIN_BUILD_PROVENANCE_PATH
    ?? join(packageRoot, 'reports', `android-client-${kind}-build-provenance.json`),
)

let configRaw = ''
try {
  run(process.execPath, [prepareScript], {
    ...process.env,
    AURORA_TAURI_ANDROID_CLIENT_CONFIG_PATH: tempConfigPath,
    AURORA_TAURI_ANDROID_CLIENT_REPORT_PATH: tempPrepareReportPath,
    AURORA_TAURI_ANDROID_VOICE_LIVE_TEST: voiceLiveTest ? '1' : '0',
  })

  configRaw = readFileSync(tempConfigPath, 'utf8')
  const config = JSON.parse(configRaw)
  const prepareReport = JSON.parse(readFileSync(tempPrepareReportPath, 'utf8'))

  run('pnpm', ['build:frontend:android-client'])
  stageFrontendDist(tempFrontendDist)
  config.build = {
    ...config.build,
    beforeBuildCommand: null,
    frontendDist: tempFrontendDist,
  }
  writeAtomicJson(tempConfigPath, config)
  configRaw = readFileSync(tempConfigPath, 'utf8')
  const configSha256 = createHash('sha256').update(configRaw).digest('hex')

  run('pnpm', ['tauri', 'android', 'init', '--ci', '--skip-targets-install'])
  run('pnpm', ['android:sync-native-plugin'], nativeSpeechBuild.env)
  cleanAndroidBuildOutputs()

  const buildArgs = ['tauri', 'android', 'build', '--debug']
  if (kind === 'apk') buildArgs.push('--apk')
  else buildArgs.push('--aab')
  buildArgs.push('--target', ...targets)
  buildArgs.push('--config', tempConfigPath)

  run('pnpm', buildArgs, androidBuildEnv(nativeSpeechBuild.env))

  mkdirSync(dirname(buildProvenancePath), { recursive: true })
  writeAtomicJson(buildProvenancePath, {
    generatedAt: new Date().toISOString(),
    bundleMode: voiceLiveTest ? 'android-client-voice-live-test' : 'android-client',
    kind,
    target: target ?? 'universal',
    targets,
    configPath: '<temp-android-client-config>',
    sourceConfigPath: redacted(sourceConfigPath),
    sourceConfigWritten: false,
    sourceConfigPresentAfterBuild: existsSync(sourceConfigPath),
    configSha256,
    config,
    prepareReport: {
      ...prepareReport,
      configPath: '<temp-android-client-config>',
    },
    command: ['pnpm', ...buildArgs.map((value) => value === tempConfigPath ? '<temp-android-client-config>' : value)],
    artifactRoot: redacted(artifactOutputRoot),
    cleanBuildOutputs: true,
    expectedCapabilities: prepareReport.expectedCapabilities,
    voiceLiveTest,
    nativeSpeechRuntime: {
      abis: nativeSpeechBuild.records.map((record) => record.abi),
      libraries: requiredNativeSpeechLibraries,
      sourceDirectoriesRedacted: true,
    },
    pythonSidecarStaged: false,
    externalBin: config.bundle?.externalBin ?? [],
    resources: config.bundle?.resources ?? {},
    secretsRedacted: true,
  })

  console.log(`Android client ${kind.toUpperCase()} build provenance wrote ${buildProvenancePath}`)
} finally {
  rmSync(sourceConfigPath, { force: true })
  rmSync(tempDir, { recursive: true, force: true })
}

function readOption(name) {
  const index = args.indexOf(name)
  return index === -1 ? null : args[index + 1]
}

function resolveNativeSpeechBuild(env, selectedTargets) {
  const records = selectedTargets.map((selectedTarget) => {
    const spec = androidTargetSpecs[selectedTarget]
    if (!spec) {
      throw new Error(
        `Unsupported Android native speech target ${selectedTarget}; expected ${Object.keys(androidTargetSpecs).join(' or ')}`,
      )
    }
    const configured = env[spec.libDirEnv]
      ?? env[`CARGO_${spec.libDirEnv}`]
    if (!configured) {
      throw new Error(
        `${spec.libDirEnv} is required to package production native speech for Android ${spec.abi}`,
      )
    }
    const libDir = resolve(configured)
    if (!existsSync(libDir)) {
      throw new Error(`${spec.libDirEnv} does not name an existing directory: ${libDir}`)
    }
    for (const library of requiredNativeSpeechLibraries) {
      if (!existsSync(join(libDir, library))) {
        throw new Error(`${spec.libDirEnv} is missing ${library}: ${libDir}`)
      }
    }
    return { target: selectedTarget, abi: spec.abi, libDirEnv: spec.libDirEnv, libDir }
  })

  const nativeEnv = {
    ...env,
    AURORA_ANDROID_NATIVE_TARGETS: selectedTargets.join(','),
    AURORA_SHERPA_ONNX_LINK_KIND: 'dynamic',
  }
  for (const record of records) nativeEnv[record.libDirEnv] = record.libDir
  return { env: nativeEnv, records }
}

function run(command, commandArgs, env = process.env) {
  const result = spawnSync(command, commandArgs, {
    cwd: packageRoot,
    env,
    stdio: 'inherit',
    shell: process.platform === 'win32',
  })
  if (result.error) throw result.error
  if (result.status !== 0) {
    throw new Error(`${command} ${commandArgs.join(' ')} failed with status ${result.status}`)
  }
}

function androidBuildEnv(env = process.env) {
  if (env.JAVA_HOME || javaCommandWorks(env)) return env

  const asdfJava = resolveAsdfJava(env)
  if (!asdfJava) return env

  return {
    ...env,
    ASDF_JAVA_VERSION: asdfJava.version,
    JAVA_HOME: asdfJava.home,
    PATH: `${join(asdfJava.home, 'bin')}${delimiter}${env.PATH ?? ''}`,
  }
}

function javaCommandWorks(env) {
  const result = spawnSync('java', ['-version'], {
    cwd: packageRoot,
    env,
    encoding: 'utf8',
    shell: process.platform === 'win32',
  })
  return result.status === 0
}

function resolveAsdfJava(env) {
  const versions = asdfJavaVersions(env)
  for (const version of versions) {
    const home = asdfJavaHome(version, env)
    if (!home || !existsSync(join(home, 'bin', process.platform === 'win32' ? 'java.exe' : 'java'))) {
      continue
    }
    return { version, home }
  }
  return null
}

function asdfJavaVersions(env) {
  const result = spawnSync('asdf', ['list', 'java'], {
    cwd: packageRoot,
    env,
    encoding: 'utf8',
    shell: process.platform === 'win32',
  })
  if (result.status !== 0) return []
  return result.stdout
    .split('\n')
    .map((line) => line.trim().replace(/^\*\s*/, ''))
    .filter(Boolean)
    .sort((left, right) => javaVersionRank(right) - javaVersionRank(left))
}

function asdfJavaHome(version, env) {
  const result = spawnSync('asdf', ['where', 'java', version], {
    cwd: packageRoot,
    env,
    encoding: 'utf8',
    shell: process.platform === 'win32',
  })
  if (result.status !== 0) return null
  return result.stdout.trim()
}

function javaVersionRank(version) {
  const match = version.match(/(?:^|[-_])(\d+)(?:[._-]|$)/)
  if (!match) return 0
  const major = Number(match[1])
  return Number.isFinite(major) ? major : 0
}

function cleanAndroidBuildOutputs() {
  rmSync(artifactOutputRoot, { recursive: true, force: true })
}

function stageFrontendDist(destination) {
  const source = join(packageRoot, 'dist')
  if (!existsSync(source)) {
    throw new Error(`Android client frontend build did not produce ${source}`)
  }
  rmSync(destination, { recursive: true, force: true })
  cpSync(source, destination, { recursive: true })
}

function writeAtomicJson(path, value) {
  const tmp = `${path}.tmp`
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`)
  renameSync(tmp, path)
}

function redacted(path) {
  return path.replace(repoRoot, '<repo-root>')
}
