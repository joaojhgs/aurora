#!/usr/bin/env node
import { readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const configPath = resolve(
  process.env.AURORA_TAURI_RELEASE_CONFIG_PATH ??
    resolve(repoRoot, 'apps/aurora-tauri/src-tauri/tauri.conf.json'),
)
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

const config = JSON.parse(readFileSync(configPath, 'utf8'))
config.version = version
config.bundle ??= {}
config.bundle.android ??= {}
config.bundle.android.versionCode = versionCode

const temporaryPath = `${configPath}.tmp`
writeFileSync(temporaryPath, `${JSON.stringify(config, null, 2)}\n`)
renameSync(temporaryPath, configPath)
console.log(`Configured unsigned Tauri packages for ${version} (Android versionCode ${versionCode})`)
