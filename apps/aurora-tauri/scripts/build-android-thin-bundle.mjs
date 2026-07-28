#!/usr/bin/env node
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const repoRoot = resolve(packageRoot, '..', '..')
const srcTauriRoot = join(packageRoot, 'src-tauri')
const sourceConfigPath = resolve(
  process.env.AURORA_TAURI_ANDROID_THIN_SOURCE_CONFIG_PATH
    ?? join(srcTauriRoot, 'tauri.android-thin.conf.json'),
)
const prepareScript = join(packageRoot, 'scripts', 'prepare-android-thin-bundle.mjs')

const args = process.argv.slice(2)
const kind = readOption('--kind') ?? (args.includes('--aab') ? 'aab' : args.includes('--apk') ? 'apk' : 'apk')
const target = readOption('--target')
if (!['apk', 'aab'].includes(kind)) {
  throw new Error(`--kind must be apk or aab, got ${kind}`)
}

const tempDir = mkdtempSync(join(tmpdir(), `aurora-android-thin-${kind}-`))
const tempConfigPath = join(tempDir, 'tauri.android-thin.conf.json')
const tempPrepareReportPath = join(tempDir, 'android-thin-bundle-prepare.json')
const buildProvenancePath = resolve(
  process.env.AURORA_TAURI_ANDROID_THIN_BUILD_PROVENANCE_PATH
    ?? join(packageRoot, 'reports', `android-thin-${kind}-build-provenance.json`),
)

let configRaw = ''
try {
  run(process.execPath, [prepareScript], {
    ...process.env,
    AURORA_TAURI_ANDROID_THIN_CONFIG_PATH: tempConfigPath,
    AURORA_TAURI_ANDROID_THIN_REPORT_PATH: tempPrepareReportPath,
  })

  configRaw = readFileSync(tempConfigPath, 'utf8')
  const config = JSON.parse(configRaw)
  const prepareReport = JSON.parse(readFileSync(tempPrepareReportPath, 'utf8'))
  const configSha256 = createHash('sha256').update(configRaw).digest('hex')

  run('pnpm', ['android:sync-native-plugin'])

  const buildArgs = ['tauri', 'android', 'build', '--debug']
  if (kind === 'apk') buildArgs.push('--apk')
  else buildArgs.push('--aab')
  if (target) buildArgs.push('--target', target)
  buildArgs.push('--config', tempConfigPath)

  run('pnpm', buildArgs)

  mkdirSync(dirname(buildProvenancePath), { recursive: true })
  writeAtomicJson(buildProvenancePath, {
    generatedAt: new Date().toISOString(),
    bundleMode: 'android-thin',
    kind,
    target: target ?? 'universal',
    configPath: '<temp-android-thin-config>',
    sourceConfigPath: redacted(sourceConfigPath),
    sourceConfigWritten: false,
    sourceConfigPresentAfterBuild: existsSync(sourceConfigPath),
    configSha256,
    config,
    prepareReport: {
      ...prepareReport,
      configPath: '<temp-android-thin-config>',
    },
    command: ['pnpm', ...buildArgs.map((value) => value === tempConfigPath ? '<temp-android-thin-config>' : value)],
    artifactRoot: redacted(join(srcTauriRoot, 'gen', 'android', 'app', 'build', 'outputs')),
    expectedCapability: 'aurora-android-thin',
    pythonSidecarStaged: false,
    externalBin: config.bundle?.externalBin ?? [],
    resources: config.bundle?.resources ?? {},
    secretsRedacted: true,
  })

  console.log(`Android-thin ${kind.toUpperCase()} build provenance wrote ${buildProvenancePath}`)
} finally {
  rmSync(sourceConfigPath, { force: true })
  rmSync(tempDir, { recursive: true, force: true })
}

function readOption(name) {
  const index = args.indexOf(name)
  return index === -1 ? null : args[index + 1]
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

function writeAtomicJson(path, value) {
  const tmp = `${path}.tmp`
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`)
  renameSync(tmp, path)
}

function redacted(path) {
  return path.replace(repoRoot, '<repo-root>')
}
