#!/usr/bin/env node
import { createHash } from 'node:crypto'
import {
  existsSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const defaultRepoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const repoRoot = resolve(process.env.AURORA_RELEASE_ROOT?.trim() || defaultRepoRoot)
const version = process.argv[2]?.trim() ?? ''
const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u.exec(
  version,
)

if (!match) {
  throw new Error(`release version must be valid SemVer, received ${JSON.stringify(version)}`)
}

const [major, minor, patch] = match.slice(1, 4).map(Number)
if (minor > 999 || patch > 999) {
  throw new Error('release minor and patch components must fit the Android version-code layout')
}
const versionCode = major * 1_000_000 + minor * 1_000 + patch
if (!Number.isSafeInteger(versionCode) || versionCode < 1 || versionCode > 2_100_000_000) {
  throw new Error(`release version ${version} cannot be represented as an Android version code`)
}

const explicitTauriConfig = process.env.AURORA_TAURI_RELEASE_CONFIG_PATH?.trim()
if (explicitTauriConfig) {
  const configPath = resolve(explicitTauriConfig)
  const config = JSON.parse(readFileSync(configPath, 'utf8'))
  config.version = version
  config.bundle ??= {}
  config.bundle.android ??= {}
  config.bundle.android.versionCode = versionCode
  commitWrites(new Map([[configPath, `${JSON.stringify(config, null, 2)}\n`]]))
  console.log(`Configured Tauri packages for ${version} (Android versionCode ${versionCode})`)
  process.exit(0)
}

const writes = new Map()
const tauriConfigPath = join(repoRoot, 'apps/aurora-tauri/src-tauri/tauri.conf.json')
const tauriConfig = readJson(tauriConfigPath)
tauriConfig.version = version
tauriConfig.bundle ??= {}
tauriConfig.bundle.android ??= {}
tauriConfig.bundle.android.versionCode = versionCode
writes.set(tauriConfigPath, `${JSON.stringify(tauriConfig, null, 2)}\n`)

replaceOnce(
  join(repoRoot, 'pyproject.toml'),
  /^(version\s*=\s*)"[^"]+"/mu,
  `$1"${version}"`,
  writes,
  'Python project version',
)
replaceOnce(
  join(repoRoot, 'app/__init__.py'),
  /^(__version__\s*=\s*)"[^"]+"/mu,
  `$1"${version}"`,
  writes,
  'Python package version',
)
replaceOnce(
  join(repoRoot, 'apps/aurora-tauri/src-tauri/Cargo.toml'),
  /^(\[package\][\s\S]*?^version\s*=\s*)"[^"]+"/mu,
  `$1"${version}"`,
  writes,
  'Tauri Cargo package version',
)
replaceOnce(
  join(repoRoot, 'apps/aurora-tauri/src-tauri/Cargo.lock'),
  /(\[\[package\]\]\r?\nname = "aurora-tauri"\r?\nversion = )"[^"]+"/u,
  `$1"${version}"`,
  writes,
  'Tauri Cargo lock version',
)
replaceOnce(
  join(repoRoot, 'packages/aurora-ui/src/version.ts'),
  /(AURORA_FALLBACK_VERSION\s*=\s*)'[^']+'/u,
  `$1'${version}'`,
  writes,
  'UI fallback version',
)
writes.set(join(repoRoot, 'VERSION'), `${version}\n`)

for (const packagePath of packageJsonPaths(repoRoot)) {
  const packageJson = readJson(packagePath)
  packageJson.version = version
  writes.set(packagePath, `${JSON.stringify(packageJson, null, 2)}\n`)
}

updateGeneratedContractVersion(version, writes)
commitWrites(writes)
console.log(
  `Configured ${writes.size} release files for ${version} (Android versionCode ${versionCode})`,
)

function updateGeneratedContractVersion(nextVersion, pendingWrites) {
  const generatedRoot = join(repoRoot, 'packages/aurora-sdk/src/generated')
  const schemaPath = join(generatedRoot, 'backend-contracts.schema.json')
  const zodPath = join(generatedRoot, 'backend-contracts.zod.ts')
  const providerPath = join(generatedRoot, 'tooling-local-provider-v1.json')
  const manifestPath = join(generatedRoot, 'backend-contracts.manifest.json')

  const schema = readJson(schemaPath)
  schema.contract_version = nextVersion
  const schemaText = `${JSON.stringify(schema, null, 2)}\n`
  const zodText = replaceTextOnce(
    readFileSync(zodPath, 'utf8'),
    /(AURORA_BACKEND_CONTRACT_VERSION\s*=\s*)"[^"]+"/u,
    `$1"${nextVersion}"`,
    'generated SDK contract version',
  )
  const provider = readJson(providerPath)
  const manifest = readJson(manifestPath)
  manifest.content_hashes = {
    'backend-contracts.schema.json': sha256(canonicalJson(schema)),
    'backend-contracts.zod.ts': sha256(zodText),
    'tooling-local-provider-v1.json': sha256(canonicalJson(provider)),
  }
  manifest.final_checksum = sha256(canonicalJson(manifest.content_hashes))

  pendingWrites.set(schemaPath, schemaText)
  pendingWrites.set(zodPath, zodText)
  pendingWrites.set(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
}

function packageJsonPaths(root) {
  const paths = [join(root, 'package.json')]
  for (const parent of ['apps', 'packages']) {
    const parentPath = join(root, parent)
    for (const entry of readdirSync(parentPath).sort(compareCodePointStrings)) {
      const candidate = join(parentPath, entry, 'package.json')
      if (existsSync(candidate) && statSync(candidate).isFile()) paths.push(candidate)
    }
  }
  return paths
}

function replaceOnce(path, pattern, replacement, pendingWrites, label) {
  const source = readFileSync(path, 'utf8')
  pendingWrites.set(path, replaceTextOnce(source, pattern, replacement, label))
}

function replaceTextOnce(source, pattern, replacement, label) {
  if (!pattern.test(source)) throw new Error(`could not locate ${label}`)
  return source.replace(pattern, replacement)
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'))
}

function commitWrites(pendingWrites) {
  const temporaryPaths = []
  try {
    for (const [path, contents] of pendingWrites) {
      const temporaryPath = `${path}.release-version-${process.pid}.tmp`
      writeFileSync(temporaryPath, contents)
      temporaryPaths.push(temporaryPath)
    }
    for (const [path] of pendingWrites) {
      const temporaryPath = `${path}.release-version-${process.pid}.tmp`
      renameSync(temporaryPath, path)
      temporaryPaths.splice(temporaryPaths.indexOf(temporaryPath), 1)
    }
  } finally {
    for (const temporaryPath of temporaryPaths) {
      if (existsSync(temporaryPath)) unlinkSync(temporaryPath)
    }
  }
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}

function canonicalJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(',')}]`
  const entries = Object.entries(value).sort(([left], [right]) => compareCodePointStrings(left, right))
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(',')}}`
}

function compareCodePointStrings(left, right) {
  const leftPoints = Array.from(left)
  const rightPoints = Array.from(right)
  const count = Math.min(leftPoints.length, rightPoints.length)
  for (let index = 0; index < count; index += 1) {
    const difference = leftPoints[index].codePointAt(0) - rightPoints[index].codePointAt(0)
    if (difference !== 0) return difference
  }
  return leftPoints.length - rightPoints.length
}
