#!/usr/bin/env node
import { mkdtempSync, rmSync, readdirSync, readFileSync, lstatSync } from 'node:fs'
import { createHash } from 'node:crypto'
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
const browserEngineAssets = [
  'apps/aurora-web/public/voice/sherpa/browser-engine.json',
  'apps/aurora-web/public/voice/sherpa/sherpa-onnx-asr.js',
  'apps/aurora-web/public/voice/sherpa/sherpa-onnx-kws.js',
  'apps/aurora-web/public/voice/sherpa/sherpa-onnx-tts.js',
  'apps/aurora-web/public/voice/sherpa/sherpa-onnx-tts.worker.js',
  'apps/aurora-web/public/voice/sherpa/sherpa-onnx-vad.js',
  'apps/aurora-web/public/voice/sherpa/sherpa-onnx-wasm-kws-main.js',
  'apps/aurora-web/public/voice/sherpa/sherpa-onnx-wasm-kws-main.wasm',
  'apps/aurora-web/public/voice/sherpa/sherpa-onnx-wasm-main-tts.js',
  'apps/aurora-web/public/voice/sherpa/sherpa-onnx-wasm-main-tts.wasm',
  'apps/aurora-web/public/voice/sherpa/sherpa-onnx-wasm-main-vad-asr.js',
  'apps/aurora-web/public/voice/sherpa/sherpa-onnx-wasm-main-vad-asr.wasm',
]

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
  checkBrowserEnginePayload()
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
  if (rel.startsWith('aurora-web-unsigned/apps/aurora-web/public/voice/sherpa/')) {
    if (!browserEngineAssets.some((asset) => rel === `aurora-web-unsigned/${asset}`)) failures.push(`unexpected browser engine asset is bundled: ${rel}`)
    if (!/\/(?:browser-engine\.json|sherpa-onnx-[a-z0-9.-]+\.(?:js|wasm))$/u.test(rel)) failures.push(`unexpected browser engine filename is bundled: ${rel}`)
  }
  if (['.onnx', '.ort', '.pt', '.pth', '.safetensors', '.gguf', '.tflite', '.tar', '.bz2', '.gz', '.zip'].includes(ext)) failures.push(`model/archive payload is bundled: ${rel}`)
  if (['.data', '.bin', '.model', '.npy', '.emb', '.fst', '.wav'].includes(ext)) failures.push(`model support payload is bundled: ${rel}`)
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

function checkBrowserEnginePayload() {
  const expectedArtifactEntries = browserEngineAssets.map((asset) => `aurora-web-unsigned/${asset}`)
  for (const entry of expectedArtifactEntries) {
    if (!checked.includes(entry)) failures.push(`required browser engine asset is missing: ${entry}`)
  }

  const unexpected = checked.filter((entry) => entry.startsWith('aurora-web-unsigned/apps/aurora-web/public/voice/sherpa/') && !expectedArtifactEntries.includes(entry))
  for (const entry of unexpected) failures.push(`unexpected browser engine asset is bundled: ${entry}`)

  const manifestPath = join(extractRoot, 'aurora-web-unsigned/apps/aurora-web/public/voice/sherpa/browser-engine.json')
  if (!checked.includes('aurora-web-unsigned/apps/aurora-web/public/voice/sherpa/browser-engine.json')) return

  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  if (manifest.schemaVersion !== 1) failures.push('browser engine manifest schema is invalid')
  if (manifest.releaseKind !== 'neutral-sherpa-browser-engine') failures.push('browser engine manifest release kind is invalid')
  if (manifest.includesModelWeights !== false) failures.push('browser engine manifest must declare no model weights')
  if (manifest.source?.id !== 'sherpa-onnx-source-v1.13.4') failures.push('browser engine manifest source id is not pinned')
  if (manifest.source?.version !== 'v1.13.4') failures.push('browser engine manifest source version is not pinned')
  if (manifest.source?.sha256 !== '3243cb386d3a4ac87596adf7d2c89fddf23e2948b154942b987b4d91c1fee295') failures.push('browser engine manifest source hash is not pinned')
  if (Object.values(manifest).some((value) => typeof value === 'string' && /\/home\/developer\/projects\/aurora|[A-Z]:\\/iu.test(value))) {
    failures.push('browser engine manifest contains an absolute build path')
  }

  const capabilities = new Set(manifest.capabilities)
  for (const capability of ['vad', 'stt', 'kws', 'tts']) {
    if (!capabilities.has(capability)) failures.push(`browser engine capability is missing: ${capability}`)
  }

  const assetRecords = new Map((manifest.assets ?? []).map((asset) => [asset.path, asset]))
  for (const asset of browserEngineAssets.filter((entry) => entry.endsWith('.js') || entry.endsWith('.wasm'))) {
    const record = assetRecords.get(asset)
    if (!record) {
      failures.push(`browser engine manifest entry is missing: ${asset}`)
      continue
    }
    if (!['vad', 'stt', 'vad-stt', 'kws', 'tts'].includes(record.capability)) failures.push(`browser engine manifest capability is invalid for ${asset}`)
    const path = join(extractRoot, `aurora-web-unsigned/${asset}`)
    const bytes = readFileSync(path)
    const sha256 = createHash('sha256').update(bytes).digest('hex')
    if (record.sha256 !== sha256) failures.push(`browser engine manifest hash mismatch for ${asset}`)
    if (record.bytes !== bytes.length) failures.push(`browser engine manifest size mismatch for ${asset}`)
  }

  for (const asset of manifest.assets ?? []) {
    if (!browserEngineAssets.includes(asset.path)) failures.push(`browser engine manifest has unexpected asset: ${asset.path}`)
    if (/\/home\/developer\/projects\/aurora|[A-Z]:\\/iu.test(JSON.stringify(asset))) failures.push(`browser engine manifest asset contains an absolute build path: ${asset.path}`)
  }
}
