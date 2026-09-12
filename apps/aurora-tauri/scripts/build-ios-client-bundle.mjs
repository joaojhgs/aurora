#!/usr/bin/env node
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const repoRoot = resolve(packageRoot, '..', '..')
const srcTauriRoot = join(packageRoot, 'src-tauri')
const reportDir = join(packageRoot, 'reports')
const prepareScript = join(packageRoot, 'scripts', 'prepare-ios-client-bundle.mjs')
const tempDir = mkdtempSync(join(tmpdir(), 'aurora-ios-client-simulator-'))
const tempConfigPath = join(tempDir, 'tauri.ios-client.conf.json')
const tempPrepareReportPath = join(tempDir, 'ios-client-bundle-prepare.json')
const buildProvenancePath = join(reportDir, 'ios-client-simulator-build-provenance.json')
const appleBuildRoot = join(srcTauriRoot, 'gen', 'apple', 'build')

try {
  run(process.execPath, [prepareScript], {
    ...process.env,
    AURORA_TAURI_IOS_CLIENT_CONFIG_PATH: tempConfigPath,
    AURORA_TAURI_IOS_CLIENT_REPORT_PATH: tempPrepareReportPath,
  })

  const configRaw = readFileSync(tempConfigPath, 'utf8')
  const config = JSON.parse(configRaw)
  const prepareReport = JSON.parse(readFileSync(tempPrepareReportPath, 'utf8'))
  const configSha256 = createHash('sha256').update(configRaw).digest('hex')
  const buildArgs = [
    'tauri',
    'ios',
    'build',
    '--target',
    'aarch64-sim',
    '--config',
    tempConfigPath,
  ]

  // Tauri uses a fixed simulator archive path. A preceding baseline build can
  // leave Aurora.app there and make the client build's final rename fail.
  rmSync(appleBuildRoot, { recursive: true, force: true })
  run('pnpm', buildArgs)

  mkdirSync(reportDir, { recursive: true })
  writeAtomicJson(buildProvenancePath, {
    generatedAt: new Date().toISOString(),
    bundleMode: 'ios-client',
    target: 'aarch64-sim',
    configPath: '<temp-ios-client-config>',
    configSha256,
    config,
    prepareReport: {
      ...prepareReport,
      configPath: '<temp-ios-client-config>',
    },
    command: [
      'pnpm',
      ...buildArgs.map((value) =>
        value === tempConfigPath ? '<temp-ios-client-config>' : value
      ),
    ],
    artifactRoot: redacted(join(srcTauriRoot, 'gen', 'apple')),
    expectedCapabilities: ['aurora-ios-thin', 'aurora-mobile-mesh'],
    pythonSidecarStaged: false,
    externalBin: config.bundle?.externalBin ?? [],
    resources: config.bundle?.resources ?? {},
    secretsRedacted: true,
  })

  console.log(`iOS client simulator build provenance wrote ${buildProvenancePath}`)
} finally {
  rmSync(tempDir, { recursive: true, force: true })
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
  const temporaryPath = `${path}.tmp`
  writeFileSync(temporaryPath, `${JSON.stringify(value, null, 2)}\n`)
  renameSync(temporaryPath, path)
}

function redacted(path) {
  return path.replace(repoRoot, '<repo-root>')
}
