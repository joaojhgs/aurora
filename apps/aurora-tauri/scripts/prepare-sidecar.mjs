import { chmodSync, copyFileSync, existsSync, mkdirSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { execFileSync, spawnSync } from 'node:child_process'

const packageRoot = resolve(dirname(new URL(import.meta.url).pathname), '..')
const repoRoot = resolve(packageRoot, '..', '..')
const srcTauriRoot = join(packageRoot, 'src-tauri')
const binaryStem = 'aurora-sidecar'
const source = process.env.AURORA_TAURI_SIDECAR_SOURCE
const cliProfile = readCliValue('--profile')
const sidecarProfile = cliProfile ?? process.env.AURORA_TAURI_SIDECAR_PROFILE ?? 'thin'
const targetTriple = process.env.AURORA_TAURI_TARGET_TRIPLE ?? detectHostTriple()
const extension = process.platform === 'win32' ? '.exe' : ''
const outputDir = join(srcTauriRoot, 'binaries')
const outputPath = join(outputDir, `${binaryStem}-${targetTriple}${extension}`)
const releaseConfigPath = join(srcTauriRoot, 'tauri.release.conf.json')
const reportDir = join(packageRoot, 'reports')
const reportPath = join(reportDir, 'sidecar-prepare.json')
const sidecarProfiles = new Set([
  'thin',
  'local-cpu',
  'local-cuda',
  'local-rocm',
  'local-metal',
  'local-vulkan',
  'local-sycl',
  'local-rpc',
  'full'
])
const profileSizeLimitsMb = {
  thin: 350,
  'local-cpu': 1800,
  'local-cuda': 6500,
  'local-rocm': 6500,
  'local-metal': 2500,
  'local-vulkan': 2500,
  'local-sycl': 2500,
  'local-rpc': 2500,
  full: 6500
}

if (!sidecarProfiles.has(sidecarProfile)) {
  throw new Error(`Unknown AURORA_TAURI_SIDECAR_PROFILE=${sidecarProfile}. Valid profiles: ${[...sidecarProfiles].join(', ')}`)
}

const { sourcePath, sourceKind } = resolveSidecarSource()
const sourceSizeBytes = statSync(sourcePath).size
enforceSizeGuard(sourcePath, sourceSizeBytes)

mkdirSync(outputDir, { recursive: true })
copyFileSync(sourcePath, outputPath)
if (process.platform !== 'win32') {
  chmodSync(outputPath, 0o755)
}
writeReleaseConfig()
writeReport({ sourcePath, sourceKind, sourceSizeBytes })

console.log(`Prepared ${basename(outputPath)} from ${redactPath(sourcePath)}`)
console.log(`Sidecar source kind: ${sourceKind}`)
console.log(`Sidecar profile: ${sidecarProfile}`)
console.log(`Wrote ${releaseConfigPath}`)
console.log(`Wrote ${reportPath}`)

function resolveSidecarSource() {
  if (source) {
    return { sourcePath: requireExecutableFile(resolve(source), 'AURORA_TAURI_SIDECAR_SOURCE'), sourceKind: 'env-override' }
  }

  const existing = findBuiltSidecar()
  if (existing) {
    return { sourcePath: existing, sourceKind: 'existing-build-output' }
  }

  if (process.env.AURORA_TAURI_SIDECAR_AUTOBUILD === '0') {
    throw new Error(
      'No built Aurora sidecar executable was found and AURORA_TAURI_SIDECAR_AUTOBUILD=0 disabled automatic building.'
    )
  }

  runSidecarBuild()
  const built = findBuiltSidecar()
  if (!built) {
    throw new Error(
      'Automatic Aurora sidecar build completed, but no executable was found. Expected dist/aurora-sidecar or dist/aurora-sidecar/aurora-sidecar.'
    )
  }
  return { sourcePath: built, sourceKind: 'auto-built' }
}

function readCliValue(name) {
  const prefix = `${name}=`
  const index = process.argv.indexOf(name)
  if (index >= 0) return process.argv[index + 1]
  const arg = process.argv.find((value) => value.startsWith(prefix))
  return arg ? arg.slice(prefix.length) : null
}

function findBuiltSidecar() {
  const explicitOutput = process.env.AURORA_TAURI_SIDECAR_BUILD_OUTPUT
  const allowLegacyOutput = process.env.AURORA_TAURI_SIDECAR_ALLOW_LEGACY_OUTPUT === '1'
  const candidates = [
    explicitOutput ? resolve(explicitOutput) : null,
    join(repoRoot, 'dist', 'sidecars', sidecarProfile, `${binaryStem}${extension}`),
    join(repoRoot, 'dist', 'sidecars', sidecarProfile, binaryStem, `${binaryStem}${extension}`),
    join(repoRoot, 'dist', `${binaryStem}-${sidecarProfile}${extension}`),
    allowLegacyOutput ? join(repoRoot, 'dist', `${binaryStem}${extension}`) : null,
    allowLegacyOutput ? join(repoRoot, 'dist', binaryStem, `${binaryStem}${extension}`) : null,
    allowLegacyOutput ? join(repoRoot, 'dist', `Aurora${extension}`) : null,
    allowLegacyOutput ? join(repoRoot, 'dist', 'Aurora', `Aurora${extension}`) : null
  ].filter(Boolean)

  for (const candidate of candidates) {
    if (isExecutableFile(candidate)) return candidate
  }
  return null
}

function runSidecarBuild() {
  const override = process.env.AURORA_TAURI_SIDECAR_BUILD_COMMAND
  if (override) {
    console.log('Building Aurora sidecar with override command from AURORA_TAURI_SIDECAR_BUILD_COMMAND (redacted)')
    const result = spawnSync(override, { cwd: repoRoot, shell: true, stdio: 'inherit', env: process.env })
    if (result.status !== 0) {
      throw new Error(`AURORA_TAURI_SIDECAR_BUILD_COMMAND failed with status ${result.status}`)
    }
    return
  }

  const command = [
    'uv',
    'run',
    '--isolated',
    '--no-dev',
    'python',
    'scripts/build.py',
    '--target',
    'exe',
    '--clean',
    '--sidecar',
    '--sidecar-profile',
    sidecarProfile
  ]
  console.log(`Building Aurora sidecar automatically in an isolated uv environment: ${command.join(' ')}`)
  let result = spawnSync(command[0], command.slice(1), { cwd: repoRoot, stdio: 'inherit', env: process.env })
  if (result.error && result.error.code === 'ENOENT') {
    const fallback = [
      'python',
      'scripts/build.py',
      '--target',
      'exe',
      '--clean',
      '--sidecar',
      '--sidecar-profile',
      sidecarProfile
    ]
    console.log(`uv was not found; falling back to: ${fallback.join(' ')}`)
    result = spawnSync(fallback[0], fallback.slice(1), { cwd: repoRoot, stdio: 'inherit', env: process.env })
  }
  if (result.status !== 0) {
    throw new Error(`Automatic Aurora sidecar build failed with status ${result.status}`)
  }
}

function requireExecutableFile(path, label) {
  if (!isExecutableFile(path)) {
    throw new Error(`${label} is not an executable file: ${path}`)
  }
  return path
}

function isExecutableFile(path) {
  if (!path || !existsSync(path)) return false
  const stat = statSync(path)
  if (!stat.isFile()) return false
  if (process.platform === 'win32') return true
  return Boolean(stat.mode & 0o111)
}

function enforceSizeGuard(path, sizeBytes) {
  const configured = process.env.AURORA_TAURI_SIDECAR_MAX_MB
  const maxMb = configured ? Number.parseFloat(configured) : profileSizeLimitsMb[sidecarProfile]
  if (!Number.isFinite(maxMb) || maxMb <= 0) return
  const sizeMb = sizeBytes / 1024 / 1024
  if (sizeMb > maxMb) {
    throw new Error(
      `Sidecar ${path} is ${sizeMb.toFixed(1)} MB, above ${maxMb} MB for profile ${sidecarProfile}. ` +
        'Use the matching profile-specific build output, choose a larger explicit profile, or set AURORA_TAURI_SIDECAR_MAX_MB for an intentional override.'
    )
  }
}

function writeReleaseConfig() {
  const config = {
    bundle: {
      externalBin: [`binaries/${binaryStem}`],
      resources: {
        '../../../app/services/config/config_defaults.json': 'app/services/config/config_defaults.json'
      }
    }
  }
  const tmpPath = `${releaseConfigPath}.tmp`
  writeFileSync(tmpPath, `${JSON.stringify(config, null, 2)}\n`)
  renameSync(tmpPath, releaseConfigPath)
}

function writeReport({ sourcePath, sourceKind, sourceSizeBytes }) {
  mkdirSync(reportDir, { recursive: true })
  const report = {
    generatedAt: new Date().toISOString(),
    sidecarProfile,
    sourceKind,
    sourcePath: redactPath(sourcePath),
    outputPath: redactPath(outputPath),
    sourceBasename: basename(sourcePath),
    outputBasename: basename(outputPath),
    sourceSizeBytes,
    sourceSizeMb: Number((sourceSizeBytes / 1024 / 1024).toFixed(1)),
    maxSizeMb: profileSizeLimitsMb[sidecarProfile] ?? null,
    targetTriple,
    releaseConfigPath: redactPath(releaseConfigPath),
    externalBin: `binaries/${binaryStem}`,
    resources: ['app/services/config/config_defaults.json'],
    autoBuildDefault: !source,
    secretsRedacted: true
  }
  writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`)
}

function redactPath(path) {
  return path ? `<host-path-redacted>/${basename(path)}` : null
}

function detectHostTriple() {
  try {
    return execFileSync('rustc', ['--print', 'host-tuple'], { encoding: 'utf8' }).trim()
  } catch {
    const verbose = execFileSync('rustc', ['-Vv'], { encoding: 'utf8' })
    const host = verbose
      .split(/\r?\n/)
      .find((line) => line.startsWith('host:'))
      ?.replace('host:', '')
      .trim()
    if (host) return host
    throw new Error('Unable to detect Rust host target triple for Tauri sidecar naming.')
  }
}
