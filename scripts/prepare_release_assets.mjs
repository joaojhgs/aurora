#!/usr/bin/env node
import { createHash } from 'node:crypto'
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { basename, join, relative, resolve } from 'node:path'

const root = resolve(requiredOption('--root'))
const version = requiredOption('--version')
const tag = requiredOption('--tag')
const sourceCommit = requiredOption('--source-commit')
const releaseCommit = requiredOption('--release-commit')
const semver = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u

if (!semver.test(version)) throw new Error(`invalid release version: ${version}`)
if (tag !== `v${version}`) throw new Error(`release tag ${tag} does not match version ${version}`)
if (!/^[a-f0-9]{40}$/u.test(sourceCommit) || !/^[a-f0-9]{40}$/u.test(releaseCommit)) {
  throw new Error('source and release commits must be full lowercase Git object IDs')
}
if (!existsSync(root)) throw new Error(`release artifact root does not exist: ${root}`)

const sourceFiles = collectFiles(root).filter((path) => !path.includes(`${join(root, 'published')}/`))
const definitions = [
  ['desktop-client-linux-appimage', (path) => inGroup(path, 'desktop/client') && path.endsWith('.AppImage'), `aurora-${version}-desktop-client-linux-x86_64.AppImage`],
  ['desktop-client-linux-deb', (path) => inGroup(path, 'desktop/client') && path.endsWith('.deb'), `aurora-${version}-desktop-client-linux-x86_64.deb`],
  ['desktop-client-linux-rpm', (path) => inGroup(path, 'desktop/client') && path.endsWith('.rpm'), `aurora-${version}-desktop-client-linux-x86_64.rpm`],
  ['desktop-client-macos-dmg', (path) => inGroup(path, 'desktop/client') && path.endsWith('.dmg'), `aurora-${version}-desktop-client-macos-arm64.dmg`],
  ['desktop-client-windows-msi', (path) => inGroup(path, 'desktop/client') && path.endsWith('.msi'), `aurora-${version}-desktop-client-windows-x86_64.msi`],
  ['desktop-client-windows-nsis', (path) => inGroup(path, 'desktop/client') && (/-setup\.exe$/iu.test(path) || /setup[^/]*\.exe$/iu.test(path)), `aurora-${version}-desktop-client-windows-x86_64-setup.exe`],
  ['desktop-local-linux-appimage', (path) => inGroup(path, 'desktop/local') && path.endsWith('.AppImage'), `aurora-${version}-desktop-local-linux-x86_64.AppImage`],
  ['desktop-local-linux-deb', (path) => inGroup(path, 'desktop/local') && path.endsWith('.deb'), `aurora-${version}-desktop-local-linux-x86_64.deb`],
  ['desktop-local-linux-rpm', (path) => inGroup(path, 'desktop/local') && path.endsWith('.rpm'), `aurora-${version}-desktop-local-linux-x86_64.rpm`],
  ['android-apk', (path) => inGroup(path, 'android') && path.endsWith('.apk'), `aurora-${version}-android-arm64-unsigned.apk`],
  ['android-aab', (path) => inGroup(path, 'android') && path.endsWith('.aab'), `aurora-${version}-android-unsigned.aab`],
  ['ios-simulator', (path) => inGroup(path, 'ios') && path.endsWith('.zip') && /ios|simulator/iu.test(path), `aurora-${version}-ios-simulator.zip`],
  ['web-standalone', (path) => inGroup(path, 'portable') && path.endsWith('.tar.gz') && /aurora-web/iu.test(path), `aurora-${version}-web.tar.gz`],
  ['server', (path) => inGroup(path, 'portable') && path.endsWith('.tar.gz') && /aurora-server/iu.test(path), `aurora-${version}-server.tar.gz`],
  ['python-wheel', (path) => inGroup(path, 'portable') && path.endsWith('.whl') && /^aurora[-_]/iu.test(basename(path)), basename],
  ['python-sdist', (path) => inGroup(path, 'portable') && path.endsWith('.tar.gz') && /^aurora[-_]/iu.test(basename(path)) && !/aurora-(?:web|server)/iu.test(path), basename],
]

const selected = []
for (const [artifactClass, predicate, outputName] of definitions) {
  const matches = sourceFiles.filter(predicate)
  if (matches.length !== 1) {
    throw new Error(`expected exactly one ${artifactClass} artifact; found ${matches.length}: ${matches.map((path) => relative(root, path)).join(', ') || 'none'}`)
  }
  selected.push({
    artifactClass,
    source: matches[0],
    outputName: typeof outputName === 'function' ? outputName(matches[0]) : outputName,
  })
}

if (selected.some((artifact) => /debug/iu.test(artifact.source))) {
  throw new Error('debug packages are forbidden from the canonical release payload')
}

const publishedRoot = join(root, 'published')
rmSync(publishedRoot, { recursive: true, force: true })
mkdirSync(publishedRoot, { recursive: true })

const artifacts = selected
  .map(({ artifactClass, source, outputName }) => {
    const destination = join(publishedRoot, outputName)
    copyFileSync(source, destination)
    return {
      class: artifactClass,
      path: relative(root, destination).replaceAll('\\', '/'),
      bytes: statSync(destination).size,
      sha256: sha256(readFileSync(destination)),
    }
  })
  .sort((left, right) => compareCodePointStrings(left.path, right.path))

const manifest = {
  schema: 'aurora.release-manifest.v1',
  version,
  tag,
  sourceCommit,
  releaseCommit,
  signed: false,
  artifacts,
}
const manifestPath = join(publishedRoot, 'RELEASE-MANIFEST.json')
writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)

const sums = artifacts.map((artifact) => `${artifact.sha256}  ${basename(artifact.path)}`).join('\n')
writeFileSync(join(publishedRoot, 'SHA256SUMS'), `${sums}\n`)
writeFileSync(
  join(publishedRoot, 'UNSIGNED-ARTIFACTS.txt'),
  [
    `Aurora ${version}`,
    `Tag: ${tag}`,
    `Source commit: ${sourceCommit}`,
    `Release commit: ${releaseCommit}`,
    'These packages are not code-signed, notarized, or store-signed.',
    'The iOS package is a simulator build. Android APK/AAB outputs require signing before distribution or installation.',
    '',
  ].join('\n'),
)

const releaseFiles = [
  ...artifacts.map((artifact) => join(root, artifact.path)),
  manifestPath,
  join(publishedRoot, 'SHA256SUMS'),
  join(publishedRoot, 'UNSIGNED-ARTIFACTS.txt'),
]
writeFileSync(join(root, 'RELEASE-ASSETS.txt'), `${releaseFiles.join('\n')}\n`)
console.log(`Prepared ${artifacts.length} canonical release packages for ${tag}`)

function requiredOption(name) {
  const index = process.argv.indexOf(name)
  const value = index === -1 ? '' : process.argv[index + 1]?.trim() ?? ''
  if (!value) throw new Error(`${name} is required`)
  return value
}

function collectFiles(directory) {
  const files = []
  const stack = [directory]
  while (stack.length) {
    const current = stack.pop()
    const stat = lstatSync(current)
    if (stat.isSymbolicLink()) throw new Error(`release artifacts must not contain symlinks: ${current}`)
    if (stat.isDirectory()) {
      for (const entry of readdirSync(current).sort(compareCodePointStrings).reverse()) {
        stack.push(join(current, entry))
      }
    } else if (stat.isFile()) {
      files.push(current)
    }
  }
  return files.sort(compareCodePointStrings)
}

function inGroup(path, group) {
  const normalized = relative(root, path).replaceAll('\\', '/')
  return normalized === group || normalized.startsWith(`${group}/`)
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
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
