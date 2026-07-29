import { spawn } from 'node:child_process'
import { constants as osConstants, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const browserStorageSteps = Object.freeze([
  {
    name: 'build @aurora/ui',
    command: 'pnpm',
    args: ['--filter', '@aurora/ui', 'build'],
  },
  {
    name: 'browser persistence matrix',
    command: 'pnpm',
    args: ['exec', 'playwright', 'test', '--config', 'tests/e2e/browser_persistence/playwright.config.ts'],
  },
  {
    name: 'non-extractable envelope-key smoke',
    command: 'pnpm',
    args: [
      'exec',
      'playwright',
      'test',
      '--config',
      'packages/aurora-ui/tests/browser-envelope-crypto.playwright.config.ts',
    ],
  },
  {
    name: 'IndexedDB to Worker OPFS transfer smoke',
    command: 'pnpm',
    args: [
      'exec',
      'playwright',
      'test',
      '--config',
      'packages/aurora-ui/tests/browser-backend-transfer.playwright.config.ts',
    ],
  },
])

export async function runBrowserStorageGate({
  steps = browserStorageSteps,
  runStep = spawnStep,
  log = console.log,
} = {}) {
  for (const [index, step] of steps.entries()) {
    log(`[browser-storage] ${index + 1}/${steps.length} ${step.name}`)
    const result = await runStep(step)
    if (result.status !== 0) return result
  }
  return { status: 0 }
}

export function spawnStep(step) {
  return new Promise((resolve, reject) => {
    const child = spawn(step.command, step.args, {
      stdio: 'inherit',
      env: {
        ...process.env,
        BROWSER_STORAGE_REPORT_ROOT: resolveBrowserStorageReportRoot(),
      },
    })
    child.once('error', reject)
    child.once('exit', (code, signal) => {
      if (signal !== null) {
        resolve({ status: 1, signal })
        return
      }
      resolve({ status: code ?? 1 })
    })
  })
}

export function resolveBrowserStorageReportRoot({
  cwd = process.cwd(),
  env = process.env,
  defaultRoot = join(tmpdir(), 'aurora-browser-storage'),
} = {}) {
  const configuredRoot = env.BROWSER_STORAGE_REPORT_ROOT
  if (configuredRoot === undefined || configuredRoot === '') {
    return defaultRoot
  }
  return resolve(cwd, configuredRoot)
}

export async function main() {
  const result = await runBrowserStorageGate()
  process.exitCode = result.signal === undefined ? result.status : signalExitCode(result.signal)
}

function signalExitCode(signal) {
  const signalNumber = osConstants.signals[signal]
  return typeof signalNumber === 'number' ? 128 + signalNumber : 1
}

const invokedPath = process.argv[1] === undefined ? undefined : resolve(process.argv[1])
if (invokedPath === fileURLToPath(import.meta.url)) {
  await main()
}
