#!/usr/bin/env node
import { createHash } from 'node:crypto'
import { cpSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

import { loadSelectedBrowserEngineSource } from './browser-engine-release-source.mjs'

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const repoRoot = resolve(packageRoot, '..', '..')
const outDir = resolve(process.env.AURORA_WEB_RELEASE_DIR ?? join(packageRoot, 'dist'))
const stageDir = join(outDir, 'aurora-web-unsigned')
const artifactPath = resolve(process.env.AURORA_WEB_RELEASE_ARTIFACT ?? join(outDir, 'aurora-web-unsigned.tar.gz'))
const reportPath = resolve(process.env.AURORA_WEB_RELEASE_REPORT ?? join(outDir, 'aurora-web-unsigned.json'))
const browserEngineReleaseDir = process.env.AURORA_BROWSER_ENGINE_RELEASE_DIR
const expectedBrowserEngineSource = loadSelectedBrowserEngineSource(repoRoot)
const browserEngineAssets = [
  { capability: 'vad', source: 'assets/vad-stt/sherpa-onnx-vad.js', target: 'sherpa-onnx-vad.js' },
  { capability: 'stt', source: 'assets/vad-stt/sherpa-onnx-asr.js', target: 'sherpa-onnx-asr.js' },
  { capability: 'vad-stt', source: 'assets/vad-stt/sherpa-onnx-wasm-main-vad-asr.js', target: 'sherpa-onnx-wasm-main-vad-asr.js' },
  { capability: 'vad-stt', source: 'assets/vad-stt/sherpa-onnx-wasm-main-vad-asr.wasm', target: 'sherpa-onnx-wasm-main-vad-asr.wasm' },
  { capability: 'kws', source: 'assets/kws/sherpa-onnx-kws.js', target: 'sherpa-onnx-kws.js' },
  { capability: 'kws', source: 'assets/kws/sherpa-onnx-wasm-kws-main.js', target: 'sherpa-onnx-wasm-kws-main.js' },
  { capability: 'kws', source: 'assets/kws/sherpa-onnx-wasm-kws-main.wasm', target: 'sherpa-onnx-wasm-kws-main.wasm' },
  { capability: 'tts', source: 'assets/tts/sherpa-onnx-tts.js', target: 'sherpa-onnx-tts.js' },
  { capability: 'tts', source: 'assets/tts/sherpa-onnx-tts.worker.js', target: 'sherpa-onnx-tts.worker.js' },
  { capability: 'tts', source: 'assets/tts/sherpa-onnx-wasm-main-tts.js', target: 'sherpa-onnx-wasm-main-tts.js' },
  { capability: 'tts', source: 'assets/tts/sherpa-onnx-wasm-main-tts.wasm', target: 'sherpa-onnx-wasm-main-tts.wasm' },
]

for (const required of ['.next', 'package.json', 'next.config.mjs', 'next-env.d.ts', 'public']) {
  if (!existsSync(join(packageRoot, required))) {
    throw new Error(`missing ${required}; run pnpm --filter @aurora/web build first`)
  }
}

rmSync(stageDir, { recursive: true, force: true })
mkdirSync(stageDir, { recursive: true })
const standaloneRoot = join(packageRoot, '.next', 'standalone')
if (!existsSync(standaloneRoot)) {
  throw new Error('missing .next/standalone; ensure next.config.mjs sets output: standalone and rerun the build')
}
cpSync(standaloneRoot, stageDir, {
  recursive: true,
  dereference: true,
  filter: releaseFilter,
})
mkdirSync(join(stageDir, 'apps', 'aurora-web', '.next'), { recursive: true })
cpSync(join(packageRoot, '.next', 'static'), join(stageDir, 'apps', 'aurora-web', '.next', 'static'), {
  recursive: true,
  dereference: true,
  filter: releaseFilter,
})
cpSync(join(packageRoot, 'public'), join(stageDir, 'apps', 'aurora-web', 'public'), { recursive: true, dereference: true })
sanitizeStandaloneServer()
const browserEngineManifest = stageBrowserEngineRelease()
writeFileSync(join(stageDir, 'RELEASE.json'), `${JSON.stringify({
  name: '@aurora/web',
  mode: 'unsigned-web-pwa',
  generatedAt: new Date(0).toISOString(),
  includesModelWeights: false,
  modelDelivery: 'selected-download-cache',
  browserEngine: {
    path: 'apps/aurora-web/public/voice/sherpa/browser-engine.json',
    releaseKind: browserEngineManifest.releaseKind,
    source: browserEngineManifest.source,
    capabilities: browserEngineManifest.capabilities,
  },
  startCommand: 'node apps/aurora-web/server.js',
}, null, 2)}\n`)

rmSync(artifactPath, { force: true })
const tar = spawnSync('tar', [
  '--sort=name',
  '--mtime=@0',
  '--owner=0',
  '--group=0',
  '--numeric-owner',
  '-czf',
  artifactPath,
  '-C',
  outDir,
  'aurora-web-unsigned',
], { cwd: repoRoot, encoding: 'utf8' })
if (tar.status !== 0) {
  throw new Error(`tar failed: ${tar.stderr || tar.stdout}`)
}

const bytes = statSync(artifactPath).size
const sha256 = createHash('sha256').update(readFileSync(artifactPath)).digest('hex')
const report = {
  artifact: relative(repoRoot, artifactPath),
  bytes,
  sha256,
  reproducibleTarOptions: ['--sort=name', '--mtime=@0', '--owner=0', '--group=0', '--numeric-owner'],
}
writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`)
console.log(`Wrote ${report.artifact} (${bytes} bytes, sha256 ${sha256})`)

function releaseFilter(source) {
  if (!existsSync(source)) return false
  const stat = lstatSync(source)
  if (stat.isSymbolicLink() && !existsSync(source)) return false
  const parts = relative(packageRoot, source).split(/[\\/]/u)
  if (parts.includes('cache')) return false
  const lower = source.toLowerCase()
  if (lower.endsWith('.map') || lower.endsWith('.nft.json')) return false
  if (lower.endsWith('required-server-files.json') || lower.endsWith('required-server-files.js')) return false
  return true
}

function sanitizeStandaloneServer() {
  const serverPath = join(stageDir, 'apps', 'aurora-web', 'server.js')
  if (!existsSync(serverPath)) throw new Error('standalone server.js is missing from packaged output')
  const escapedRepoRoot = repoRoot.replaceAll('\\', '\\\\')
  const original = readFileSync(serverPath, 'utf8')
  const sanitized = original.replaceAll(repoRoot, '.').replaceAll(escapedRepoRoot, '.')
  writeFileSync(serverPath, sanitized)
}

function stageBrowserEngineRelease() {
  if (!browserEngineReleaseDir) {
    throw new Error('AURORA_BROWSER_ENGINE_RELEASE_DIR is required for the unsigned web release package')
  }
  const releaseRoot = resolve(browserEngineReleaseDir)
  const provenancePath = join(releaseRoot, 'reports', 'browser-engine-release.provenance.json')
  const sumsPath = join(releaseRoot, 'reports', 'SHA256SUMS')
  if (!existsSync(provenancePath) || !existsSync(sumsPath)) {
    throw new Error(`browser engine release is missing provenance or SHA256SUMS: ${releaseRoot}`)
  }

  const provenance = JSON.parse(readFileSync(provenancePath, 'utf8'))
  if (provenance.schema_version !== 1 || provenance.release_kind !== 'neutral-sherpa-browser-engine') {
    throw new Error('browser engine release provenance has an unexpected schema or release kind')
  }
  if (provenance.policy?.payload !== 'engine-code-only' || provenance.policy?.contains_model_weights !== false) {
    throw new Error('browser engine release provenance does not declare engine-code-only payload')
  }
  for (const [key, expected] of Object.entries(expectedBrowserEngineSource)) {
    if (provenance.source?.[key] !== expected) {
      throw new Error(`browser engine release source ${key} mismatch: expected ${expected}`)
    }
  }

  const expectedSources = new Set(browserEngineAssets.map((asset) => asset.source))
  const actualSources = listAssetFiles(join(releaseRoot, 'assets')).map((asset) => `assets/${asset}`)
  const unexpected = actualSources.filter((asset) => !expectedSources.has(asset))
  const missing = [...expectedSources].filter((asset) => !actualSources.includes(asset))
  if (unexpected.length || missing.length) {
    throw new Error(`browser engine asset set mismatch; missing=${missing.join(',') || 'none'} unexpected=${unexpected.join(',') || 'none'}`)
  }

  const sums = parseSha256Sums(readFileSync(sumsPath, 'utf8'))
  const stagedRoot = join(stageDir, 'apps', 'aurora-web', 'public', 'voice', 'sherpa')
  rmSync(stagedRoot, { recursive: true, force: true })
  mkdirSync(stagedRoot, { recursive: true })
  const manifestAssets = []
  for (const asset of browserEngineAssets) {
    const sourcePath = join(releaseRoot, asset.source)
    const expectedHash = sums.get(asset.source)
    if (!expectedHash) throw new Error(`missing browser engine hash for ${asset.source}`)
    assertAllowedEngineAsset(sourcePath, asset.source, asset.target)
    const bytes = readFileSync(sourcePath)
    const sha256 = createHash('sha256').update(bytes).digest('hex')
    if (sha256 !== expectedHash) throw new Error(`browser engine hash mismatch for ${asset.source}`)
    const targetPath = join(stagedRoot, asset.target)
    writeFileSync(targetPath, bytes)
    manifestAssets.push({
      capability: asset.capability,
      path: `apps/aurora-web/public/voice/sherpa/${asset.target}`,
      sha256,
      bytes: bytes.length,
    })
  }

  const manifest = {
    schemaVersion: 1,
    releaseKind: provenance.release_kind,
    source: {
      id: provenance.source.id,
      version: provenance.source.version,
      sha256: provenance.source.sha256,
      archiveVerified: provenance.source.archive_verified === true,
    },
    capabilities: ['vad', 'stt', 'kws', 'tts'],
    includesModelWeights: false,
    assets: manifestAssets.sort((a, b) => a.path.localeCompare(b.path)),
  }
  writeFileSync(join(stagedRoot, 'browser-engine.json'), `${JSON.stringify(manifest, null, 2)}\n`)
  return manifest
}

function listAssetFiles(root, prefix = '') {
  if (!existsSync(root)) throw new Error(`browser engine assets directory is missing: ${root}`)
  const files = []
  for (const name of readdirSync(root)) {
    const path = join(root, name)
    const rel = prefix ? `${prefix}/${name}` : name
    const stat = lstatSync(path)
    if (stat.isSymbolicLink()) throw new Error(`browser engine asset symlink is not allowed: ${rel}`)
    if (stat.isDirectory()) {
      files.push(...listAssetFiles(path, rel))
    } else {
      files.push(rel)
    }
  }
  return files.sort()
}

function parseSha256Sums(text) {
  const sums = new Map()
  for (const line of text.split(/\r?\n/u)) {
    if (!line.trim()) continue
    const match = /^([a-f0-9]{64})  (assets\/[^\s]+)$/u.exec(line)
    if (!match) throw new Error(`invalid SHA256SUMS line: ${line}`)
    sums.set(match[2], match[1])
  }
  return sums
}

function assertAllowedEngineAsset(sourcePath, sourceRel, targetName) {
  const lower = sourceRel.toLowerCase()
  if (!/^[a-z0-9.-]+\.(?:js|wasm)$/u.test(targetName)) throw new Error(`unexpected browser engine filename: ${sourceRel}`)
  if (/\.(?:onnx|ort|pt|pth|safetensors|gguf|tflite|tar|bz2|gz|zip|data|bin|model|npy|emb|fst|wav)$/iu.test(lower)) {
    throw new Error(`browser engine release contains forbidden payload: ${sourceRel}`)
  }
  if (!lstatSync(sourcePath).isFile()) throw new Error(`browser engine asset is not a regular file: ${sourceRel}`)
}
