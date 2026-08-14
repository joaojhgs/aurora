#!/usr/bin/env node
import { createHash } from 'node:crypto'
import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const repoRoot = resolve(packageRoot, '..', '..')
const outDir = resolve(process.env.AURORA_WEB_RELEASE_DIR ?? join(packageRoot, 'dist'))
const stageDir = join(outDir, 'aurora-web-unsigned')
const artifactPath = resolve(process.env.AURORA_WEB_RELEASE_ARTIFACT ?? join(outDir, 'aurora-web-unsigned.tar.gz'))
const reportPath = resolve(process.env.AURORA_WEB_RELEASE_REPORT ?? join(outDir, 'aurora-web-unsigned.json'))

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
writeFileSync(join(stageDir, 'RELEASE.json'), `${JSON.stringify({
  name: '@aurora/web',
  mode: 'unsigned-web-pwa',
  generatedAt: new Date(0).toISOString(),
  includesModelWeights: false,
  modelDelivery: 'selected-download-cache',
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
