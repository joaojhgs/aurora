#!/usr/bin/env node
import { mkdtempSync, rmSync, readdirSync, readFileSync, lstatSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, extname, join, relative, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const repoRoot = resolve(packageRoot, '..', '..')
const artifact = resolve(process.env.AURORA_WEB_RELEASE_ARTIFACT ?? process.argv[2] ?? join(packageRoot, 'dist', 'aurora-web-unsigned.tar.gz'))
const extractRoot = mkdtempSync(join(tmpdir(), 'aurora-web-release-'))
const failures = []
const checked = []

try {
  const tar = spawnSync('tar', ['-xzf', artifact, '-C', extractRoot], { encoding: 'utf8' })
  if (tar.status !== 0) throw new Error(`tar extract failed: ${tar.stderr || tar.stdout}`)
  walk(extractRoot)
  if (!checked.some((entry) => entry.endsWith('manifest.webmanifest'))) failures.push('PWA manifest is missing')
  const serviceWorker = checked.find((entry) => entry.endsWith('/sw.js'))
  if (!serviceWorker) {
    failures.push('service worker is missing')
  } else {
    checkServiceWorkerPolicy(join(extractRoot, serviceWorker), serviceWorker)
  }
  if (failures.length) {
    console.error(`Web release artifact check failed for ${relative(repoRoot, artifact)}`)
    for (const failure of failures) console.error(`- ${failure}`)
    process.exit(1)
  }
  console.log(`Web release artifact check passed for ${relative(repoRoot, artifact)} (${checked.length} files)`)
} finally {
  rmSync(extractRoot, { recursive: true, force: true })
}

function walk(root) {
  for (const name of readdirSync(root)) {
    const path = join(root, name)
    const stat = lstatSync(path)
    const rel = relative(extractRoot, path)
    if (stat.isSymbolicLink()) {
      failures.push(`symlink is not allowed: ${rel}`)
      continue
    }
    if (stat.isDirectory()) {
      walk(path)
      continue
    }
    checked.push(rel)
    checkName(rel)
    checkText(path, rel)
  }
}

function checkName(rel) {
  const lower = rel.toLowerCase()
  const ext = extname(lower)
  const base = basename(lower)
  if (['.onnx', '.ort', '.pt', '.pth', '.safetensors', '.gguf', '.tflite', '.tar', '.bz2', '.gz', '.zip'].includes(ext)) failures.push(`model/archive payload is bundled: ${rel}`)
  if (['.py', '.pyc', '.pyo'].includes(ext) || /(^|\/)(__pycache__|site-packages|\.venv|venv)(\/|$)/iu.test(rel)) failures.push(`Python payload is bundled: ${rel}`)
  if (/aurora-sidecar|prepare-sidecar|gateway-sidecar|libpython/iu.test(rel)) failures.push(`sidecar payload is bundled: ${rel}`)
  if (base.endsWith('.map')) failures.push(`source map is bundled: ${rel}`)
}

function checkText(path, rel) {
  const ext = extname(rel).toLowerCase()
  if (!['.js', '.json', '.html', '.css', '.txt', '.svg', '.webmanifest'].includes(ext)) return
  const text = readFileSync(path, 'utf8')
  if (/\/home\/developer\/projects\/aurora|[A-Z]:\\[^"']*aurora/iu.test(text)) failures.push(`absolute source path leaked: ${rel}`)
  if (/(sk-(?:proj|live|test)-[A-Za-z0-9_-]{32,}|BEGIN (?:RSA|OPENSSH|EC|PRIVATE) KEY)/u.test(text)) failures.push(`secret-like text leaked: ${rel}`)
  if (/https:\/\/github\.com\/k2-fsa\/sherpa-onnx\/releases\/download\/tts-models\/sherpa-onnx-wasm/iu.test(text)) failures.push(`mutable remote engine asset is referenced: ${rel}`)
}

function checkServiceWorkerPolicy(path, rel) {
  const text = readFileSync(path, 'utf8')
  if (!/CACHEABLE_PATH_RE\s*=.*\/_next\\\/static\\\//u.test(text)) failures.push(`service worker static cache allowlist is missing: ${rel}`)
  if (!/NEVER_CACHE_PATH_RE\s*=.*\\\/api\\\//u.test(text)) failures.push(`service worker dynamic request denylist is missing: ${rel}`)
  if (!/request\.mode\s*===\s*['"]navigate['"]/u.test(text)) failures.push(`service worker navigation requests are not network-only: ${rel}`)
  if (!/!CACHEABLE_PATH_RE\.test\(url\.pathname\)\)\s*return/u.test(text)) failures.push(`service worker can cache requests outside the allowlist: ${rel}`)
}
