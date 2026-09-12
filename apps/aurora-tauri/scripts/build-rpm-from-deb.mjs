#!/usr/bin/env node
import { copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, relative, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const repoRoot = resolve(packageRoot, '..', '..')
const mode = requiredOption('--mode')
const bundleRoot = resolve(optionalOption('--bundle-root') ?? join(packageRoot, 'src-tauri', 'target', 'release', 'bundle'))
const reportPath = resolve(optionalOption('--report') ?? join(packageRoot, 'reports', `rpm-package-${mode}.json`))

if (!['desktop-client', 'desktop-local'].includes(mode)) throw new Error(`unsupported RPM mode: ${mode}`)
if (!existsSync(bundleRoot)) throw new Error(`bundle root does not exist: ${bundleRoot}`)

const debs = collectFiles(bundleRoot).filter((path) => path.endsWith('.deb'))
if (debs.length !== 1) {
  throw new Error(`expected exactly one DEB package; found ${debs.length}: ${debs.map((path) => relative(bundleRoot, path)).join(', ') || 'none'}`)
}

const workRoot = mkdtempSync(join(tmpdir(), 'aurora-rpm-from-deb-'))
try {
  const alien = spawnSync('alien', ['--to-rpm', '--keep-version', '--scripts', debs[0]], {
    cwd: workRoot,
    encoding: 'utf8',
  })
  if (alien.error) throw new Error(`failed to start alien: ${alien.error.message}`)
  if (alien.status !== 0) throw new Error(`alien failed: ${alien.stderr || alien.stdout}`)

  const converted = collectFiles(workRoot).filter((path) => path.endsWith('.rpm'))
  if (converted.length !== 1) {
    throw new Error(`expected alien to produce exactly one RPM; found ${converted.length}`)
  }
  const rpmDir = join(bundleRoot, 'rpm')
  mkdirSync(rpmDir, { recursive: true })
  const rpmPath = join(rpmDir, basename(converted[0]))
  copyFileSync(converted[0], rpmPath)

  const query = spawnSync('rpm', ['-qpl', rpmPath], { encoding: 'utf8' })
  if (query.error) throw new Error(`failed to start rpm: ${query.error.message}`)
  if (query.status !== 0) throw new Error(`RPM inspection failed: ${query.stderr || query.stdout}`)
  const entries = query.stdout.split(/\r?\n/u).filter(Boolean)
  if (!entries.some((entry) => entry.endsWith('.desktop'))) throw new Error('RPM is missing its desktop entry')
  if (!entries.some((entry) => entry.startsWith('/usr/bin/'))) throw new Error('RPM is missing its executable')
  const containsSidecar = entries.some((entry) => /aurora-sidecar/iu.test(entry))
  if (mode === 'desktop-local' && !containsSidecar) throw new Error('desktop-local RPM must contain the Python sidecar')
  if (mode === 'desktop-client' && containsSidecar) throw new Error('desktop-client RPM must not contain a Python sidecar')

  const report = {
    schema: 'aurora.tauri-rpm-package.v1',
    mode,
    sourceDeb: relative(repoRoot, debs[0]).replaceAll('\\', '/'),
    artifact: relative(repoRoot, rpmPath).replaceAll('\\', '/'),
    bytes: statSync(rpmPath).size,
    packageEntries: entries.length,
    containsSidecar,
  }
  mkdirSync(dirname(reportPath), { recursive: true })
  writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`)
  console.log(`Wrote ${report.artifact} from ${report.sourceDeb}`)
} finally {
  rmSync(workRoot, { recursive: true, force: true })
}

function requiredOption(name) {
  const value = optionalOption(name)
  if (!value) throw new Error(`${name} is required`)
  return value
}

function optionalOption(name) {
  const index = process.argv.indexOf(name)
  return index === -1 ? undefined : process.argv[index + 1]?.trim() || undefined
}

function collectFiles(root) {
  const files = []
  const stack = [root]
  while (stack.length) {
    const current = stack.pop()
    const stat = lstatSync(current)
    if (stat.isDirectory()) {
      for (const entry of readdirSync(current).sort().reverse()) stack.push(join(current, entry))
    } else if (stat.isFile()) {
      files.push(current)
    }
  }
  return files.sort()
}
