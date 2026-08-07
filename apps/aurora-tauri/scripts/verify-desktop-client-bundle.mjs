#!/usr/bin/env node
import { spawnSync } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const rawArgs = process.argv.slice(2).filter((arg) => arg !== '--')

const clientArgs = [...rawArgs]
const nativePolicyArgs = rawArgs.map((arg) => (
  arg === '--allow-missing-bundle' ? '--allow-missing-root' : arg
))
if (
  rawArgs.includes('--allow-missing-bundle')
  && !nativePolicyArgs.includes('--allow-missing-root')
) {
  nativePolicyArgs.push('--allow-missing-root')
}

const checks = [
  ['assert-client-bundle-clean.mjs', clientArgs],
  ['assert-native-voice-artifact-policy.mjs', nativePolicyArgs],
]

let exitStatus = 0

for (const [script, args] of checks) {
  const result = spawnSync(process.execPath, [join(packageRoot, 'scripts', script), ...args], {
    cwd: packageRoot,
    env: process.env,
    stdio: 'inherit',
  })
  if (result.error) {
    console.error(`${script} failed to start: ${result.error.message}`)
    exitStatus = exitStatus || 1
    continue
  }
  if (typeof result.status === 'number' && result.status !== 0) {
    exitStatus = exitStatus || result.status
    continue
  }
  if (result.signal) {
    console.error(`${script} terminated by signal ${result.signal}`)
    exitStatus = exitStatus || 1
  }
}

process.exit(exitStatus)
