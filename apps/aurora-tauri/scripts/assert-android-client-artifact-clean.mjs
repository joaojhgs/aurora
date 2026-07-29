#!/usr/bin/env node
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { dirname, extname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const repoRoot = resolve(packageRoot, '..', '..')
const srcTauriRoot = join(packageRoot, 'src-tauri')
const configPath = resolve(
  process.env.AURORA_TAURI_ANDROID_CLIENT_CONFIG_PATH
    ?? process.env.AURORA_TAURI_ANDROID_THIN_CONFIG_PATH
    ?? join(srcTauriRoot, 'tauri.android-client.conf.json'),
)
const capabilityPath = join(srcTauriRoot, 'capabilities', 'aurora-android-thin.json')
const mobileMeshCapabilityPath = join(
  srcTauriRoot,
  'capabilities',
  'aurora-mobile-mesh.json',
)
const expectedCapabilities = ['aurora-android-thin', 'aurora-mobile-mesh']

const args = process.argv.slice(2)
const kind = readOption('--kind') ?? 'apk'
if (!['apk', 'aab'].includes(kind)) {
  throw new Error(`--kind must be apk or aab, got ${kind}`)
}
const explicitArtifact = readOption('--artifact') ?? process.env.AURORA_ANDROID_CLIENT_ARTIFACT ?? process.env.AURORA_ANDROID_THIN_ARTIFACT
const allowMissingArtifact = args.includes('--allow-missing-artifact')
const artifactRoot = explicitArtifact
  ? dirname(resolve(explicitArtifact))
  : resolve(process.env.AURORA_ANDROID_CLIENT_ARTIFACT_DIR ?? process.env.AURORA_ANDROID_THIN_ARTIFACT_DIR ?? join(srcTauriRoot, 'gen', 'android', 'app', 'build', 'outputs'))
const reportPath = resolve(
  process.env.AURORA_TAURI_ANDROID_CLIENT_PROOF_REPORT_PATH
    ?? process.env.AURORA_TAURI_ANDROID_THIN_PROOF_REPORT_PATH
    ?? join(packageRoot, 'reports', `android-client-${kind}-artifact-proof.json`),
)
const buildProvenancePath = resolve(
  process.env.AURORA_TAURI_ANDROID_CLIENT_BUILD_PROVENANCE_PATH
    ?? process.env.AURORA_TAURI_ANDROID_THIN_BUILD_PROVENANCE_PATH
    ?? join(packageRoot, 'reports', `android-client-${kind}-build-provenance.json`),
)

const forbiddenPathPatterns = [
  /aurora-sidecar/i,
  /prepare-sidecar/i,
  /gateway-sidecar/i,
  /bundled[-_]?gateway/i,
  /config_defaults\.json/i,
  /(^|[/\\])app[/\\]services[/\\]config/i,
  /(^|[/\\])\.venv([/\\]|$)/i,
  /(^|[/\\])venv([/\\]|$)/i,
  /(^|[/\\])python(\d+(\.\d+)?)?(\.exe)?$/i,
  /libpython[^/\\]*\.(so|dylib|dll)/i,
  /pyvenv\.cfg/i,
  /site-packages/i,
  /__pycache__/i,
  /(^|[/\\])main\.py$/i,
  /(^|[/\\])uv(\.exe)?$/i
]

const forbiddenTextPatterns = [
  /aurora-sidecar/i,
  /prepare-sidecar/i,
  /app\/services\/config\/config_defaults\.json/i,
  /libpython/i,
  /site-packages/i,
  /\.venv/i,
  /bundled[-_]?gateway/i
]

const failures = []
const artifact = explicitArtifact ? resolve(explicitArtifact) : findArtifact(kind)
const proof = {
  generatedAt: new Date().toISOString(),
  bundleMode: 'android-client',
  kind,
  artifact: artifact ? redacted(artifact) : null,
  artifactRoot: redacted(artifactRoot),
  allowMissingArtifact,
  checkedArchives: 0,
  checkedEntries: 0,
  checkedFiles: 0,
  forbiddenMatches: [],
  configPath: redacted(configPath),
  buildProvenancePath: redacted(buildProvenancePath),
  expectedCapabilities,
  capabilityFilePresent: existsSync(capabilityPath),
  mobileMeshCapabilityFilePresent: existsSync(mobileMeshCapabilityPath),
  secretsRedacted: true
}

checkPackageScripts()
checkAndroidThinConfig()
checkCapabilityIfPresent()
checkArtifact()

mkdirSync(dirname(reportPath), { recursive: true })
writeFileSync(reportPath, `${JSON.stringify(proof, null, 2)}\n`)

if (failures.length) {
  console.error(`Android client ${kind.toUpperCase()} artifact proof failed. Wrote ${reportPath}`)
  for (const failure of failures) console.error(`- ${failure}`)
  process.exit(1)
}

console.log(`Android client ${kind.toUpperCase()} artifact proof passed. Wrote ${reportPath}`)

function readOption(name) {
  const index = args.indexOf(name)
  return index === -1 ? null : args[index + 1]
}

function checkPackageScripts() {
  const packageJson = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8'))
  const scripts = packageJson.scripts ?? {}
  for (const scriptName of [
    'android:prepare:client',
    'android:build:client:apk',
    'android:build:client:aab',
    'android:verify:client:apk',
    'android:verify:client:aab'
  ]) {
    if (!scripts[scriptName]) failures.push(`package.json is missing ${scriptName}`)
  }
  for (const [name, value] of Object.entries(scripts)) {
    if ((name.includes(':client') || name.includes(':thin')) && /prepare-sidecar|\bpython\b|\buv\b/i.test(String(value))) {
      failures.push(`${name} must remain Python-free and must not call uv/python/prepare-sidecar`)
    }
  }
  proof.androidClientScripts = Object.fromEntries(Object.entries(scripts).filter(([name]) => name.startsWith('android:') && name.includes(':client')))
}

function checkAndroidThinConfig() {
  const loaded = loadAndroidThinConfig()
  if (!loaded) return
  const { raw, config, source, provenance } = loaded
  const externalBin = config.bundle?.externalBin ?? []
  const resources = config.bundle?.resources ?? {}
  if (!Array.isArray(externalBin) || externalBin.length !== 0) failures.push('Android client config must have bundle.externalBin: []')
  if (Array.isArray(resources) ? resources.length !== 0 : Object.keys(resources).length !== 0) {
    failures.push('Android client config must have empty bundle.resources')
  }
  if (/binaries\/aurora-sidecar|config_defaults\.json|app\/services\/config/.test(raw)) {
    failures.push('Android client config contains sidecar/config resource references')
  }
  const capabilities = config.app?.security?.capabilities ?? []
  if (
    !Array.isArray(capabilities)
    || capabilities.length !== expectedCapabilities.length
    || capabilities.some(
      (capability, index) => capability !== expectedCapabilities[index],
    )
  ) {
    failures.push(
      `Android client config must select exactly ${expectedCapabilities.join(', ')}`,
    )
  }
  const csp = config.app?.security?.csp ?? ''
  checkRuntimeConfigurableConnectSrc(csp)
  proof.configSource = source
  proof.sourceConfigPresent = existsSync(configPath)
  proof.csp = csp
  proof.capabilities = capabilities
  proof.configExternalBin = externalBin
  proof.configResources = resources
  if (provenance) {
    proof.configSha256 = provenance.configSha256
    proof.provenanceGeneratedAt = provenance.generatedAt
  }
}

function loadAndroidThinConfig() {
  if (existsSync(configPath)) {
    const raw = readFileSync(configPath, 'utf8')
    return { raw, config: JSON.parse(raw), source: 'source-config' }
  }
  if (!existsSync(buildProvenancePath)) {
    failures.push(`Android client config is missing and ${redacted(buildProvenancePath)} does not exist; run android:build:client:${kind}`)
    return null
  }
  const provenanceRaw = readFileSync(buildProvenancePath, 'utf8')
  const provenance = JSON.parse(provenanceRaw)
  if (provenance.bundleMode !== 'android-client') failures.push('Android client build provenance has wrong bundleMode')
  if (provenance.kind !== kind) failures.push(`Android client build provenance kind mismatch: expected ${kind}, got ${provenance.kind}`)
  if (provenance.sourceConfigWritten !== false) failures.push('Android client build provenance must come from a temp config, not a source-tree generated config')
  const config = provenance.config
  if (!config || typeof config !== 'object') {
    failures.push('Android client build provenance is missing the config snapshot')
    return null
  }
  const raw = `${JSON.stringify(config, null, 2)}\n`
  const actualSha256 = createHash('sha256').update(raw).digest('hex')
  if (provenance.configSha256 !== actualSha256) {
    failures.push('Android client build provenance configSha256 does not match the config snapshot')
  }
  return { raw, config, source: 'build-provenance', provenance }
}

function checkCapabilityIfPresent() {
  if (!existsSync(capabilityPath)) return
  const capability = JSON.parse(readFileSync(capabilityPath, 'utf8'))
  const permissions = capability.permissions ?? []
  const forbidden = permissions.filter((permission) => /sidecar|aurora-request|aurora-subscribe|local-file|audio-bridge|secure-file/i.test(permission))
  if (forbidden.length) failures.push(`Android client capability includes forbidden local/sidecar permissions: ${forbidden.join(', ')}`)
  proof.clientCapabilityPermissions = permissions

  if (!existsSync(mobileMeshCapabilityPath)) {
    failures.push('Android client mobile mesh capability is missing')
    return
  }
  const mobileMeshCapability = JSON.parse(
    readFileSync(mobileMeshCapabilityPath, 'utf8'),
  )
  const mobileMeshPermissions = mobileMeshCapability.permissions ?? []
  for (const permission of [
    'deep-link:default',
    'barcode-scanner:allow-scan',
    'barcode-scanner:allow-cancel',
    'barcode-scanner:allow-check-permissions',
    'barcode-scanner:allow-request-permissions',
  ]) {
    if (!mobileMeshPermissions.includes(permission)) {
      failures.push(
        `Android client mobile mesh capability is missing ${permission}`,
      )
    }
  }
  proof.mobileMeshCapabilityPermissions = mobileMeshPermissions
}

function checkArtifact() {
  if (!artifact || !existsSync(artifact)) {
    if (allowMissingArtifact) {
      proof.artifactMissing = true
      return
    }
    failures.push(`Android client ${kind.toUpperCase()} artifact is missing under ${artifactRoot}`)
    return
  }
  if (extname(artifact) !== `.${kind}`) {
    failures.push(`Expected .${kind} artifact, got ${artifact}`)
    return
  }
  scanArtifactRoot()
  const stat = statSync(artifact)
  proof.artifactBytes = stat.size
  const entries = listZipEntries(artifact)
  proof.checkedArchives += 1
  proof.checkedEntries += entries.length
  proof.sampleEntries = entries.slice(0, 30)
  if (!entries.length) failures.push(`${kind.toUpperCase()} archive has no entries`)
  for (const entry of entries) checkName(entry, `${kind}:${entry}`)
  if (kind === 'apk' && !entries.some((entry) => entry === 'AndroidManifest.xml')) {
    failures.push('APK archive is missing AndroidManifest.xml')
  }
  if (kind === 'aab' && !entries.some((entry) => entry === 'base/manifest/AndroidManifest.xml')) {
    failures.push('AAB archive is missing base/manifest/AndroidManifest.xml')
  }
}

function listZipEntries(path) {
  let buffer
  try {
    buffer = readFileSync(path)
  } catch (error) {
    failures.push(`failed to read ${kind.toUpperCase()} archive: ${String(error?.message ?? error)}`)
    return []
  }
  try {
    return parseZipCentralDirectory(buffer)
  } catch (error) {
    failures.push(`failed to inspect ${kind.toUpperCase()} archive ${redacted(path)}: ${String(error?.message ?? error)}`)
    return []
  }
}

function parseZipCentralDirectory(buffer) {
  const eocdOffset = findEndOfCentralDirectory(buffer)
  if (eocdOffset === -1) throw new Error('ZIP end of central directory not found')
  const totalEntries = buffer.readUInt16LE(eocdOffset + 10)
  const centralDirSize = buffer.readUInt32LE(eocdOffset + 12)
  const centralDirOffset = buffer.readUInt32LE(eocdOffset + 16)
  if (centralDirOffset + centralDirSize > buffer.length) throw new Error('ZIP central directory is truncated')
  const entries = []
  let offset = centralDirOffset
  for (let index = 0; index < totalEntries; index += 1) {
    if (buffer.readUInt32LE(offset) !== 0x02014b50) throw new Error(`ZIP central directory entry ${index} has invalid signature`)
    const nameLength = buffer.readUInt16LE(offset + 28)
    const extraLength = buffer.readUInt16LE(offset + 30)
    const commentLength = buffer.readUInt16LE(offset + 32)
    const nameStart = offset + 46
    const nameEnd = nameStart + nameLength
    if (nameEnd > buffer.length) throw new Error(`ZIP central directory entry ${index} filename is truncated`)
    entries.push(buffer.subarray(nameStart, nameEnd).toString('utf8'))
    offset = nameEnd + extraLength + commentLength
  }
  return entries
}

function findEndOfCentralDirectory(buffer) {
  const min = Math.max(0, buffer.length - 0xffff - 22)
  for (let offset = buffer.length - 22; offset >= min; offset -= 1) {
    if (buffer.readUInt32LE(offset) === 0x06054b50) return offset
  }
  return -1
}

function findArtifact(ext) {
  if (!existsSync(artifactRoot)) return null
  const candidates = collectFiles(artifactRoot)
    .filter((path) => path.endsWith(`.${ext}`))
    .filter((path) => !path.endsWith(`-unsigned.${ext}`))

  const preferred = candidates.filter((path) => isPreferredGeneratedArtifact(path, ext))
  if (preferred.length === 1) return preferred[0]
  if (preferred.length > 1) {
    failures.push(`Ambiguous Android client ${ext.toUpperCase()} artifacts in preferred generated output: ${preferred.map(redacted).join(', ')}`)
    return null
  }
  if (candidates.length === 1) return candidates[0]
  if (candidates.length > 1) {
    failures.push(`Ambiguous Android client ${ext.toUpperCase()} artifacts under ${redacted(artifactRoot)}: ${candidates.map(redacted).join(', ')}`)
  }
  return null
}

function isPreferredGeneratedArtifact(path, ext) {
  const normalized = path.replace(/\\/g, '/')
  const basename = normalized.split('/').pop() ?? ''
  if (!basename.includes('universal-debug')) return false
  if (ext === 'apk') return normalized.includes('/outputs/apk/universal/debug/')
  if (ext === 'aab') return normalized.includes('/outputs/bundle/universalDebug/')
  return false
}

function checkRuntimeConfigurableConnectSrc(csp) {
  const directive = csp
    .split(';')
    .map((value) => value.trim())
    .find((value) => value.startsWith('connect-src '))
  if (!directive) {
    failures.push('Android client CSP must define connect-src')
    return
  }
  const sources = directive.split(/\s+/).slice(1)
  const expected = new Set(["'self'", 'http:', 'https:', 'ws:', 'wss:'])
  for (const source of expected) {
    if (!sources.includes(source)) {
      failures.push(`Android client CSP connect-src must include runtime-configurable source ${source}`)
    }
  }
  for (const source of sources) {
    if (expected.has(source)) continue
    failures.push(`Android client CSP connect-src must not compile endpoint-specific source ${source}`)
  }
}

function checkName(value, label) {
  for (const pattern of forbiddenPathPatterns) {
    if (pattern.test(value)) addForbidden(`${label} matched forbidden path pattern ${pattern}`)
  }
}

function addForbidden(message) {
  proof.forbiddenMatches.push(message)
  failures.push(message)
}

function scanArtifactRoot() {
  if (!existsSync(artifactRoot)) return
  for (const file of collectFiles(artifactRoot)) {
    proof.checkedFiles += 1
    const rel = relative(artifactRoot, file)
    checkName(rel, `artifact-root:${rel}`)
    if (shouldScanText(file)) checkText(file, `artifact-root:${rel}`)
  }
}

function collectFiles(root) {
  const files = []
  const stack = [root]
  while (stack.length) {
    const current = stack.pop()
    const stat = lstatSync(current)
    if (stat.isSymbolicLink()) continue
    if (stat.isDirectory()) {
      for (const child of readdirSync(current)) stack.push(join(current, child))
    } else if (stat.isFile()) {
      files.push(current)
    }
  }
  return files
}

function checkText(path, label) {
  const stat = statSync(path)
  if (stat.size > 2_000_000) return
  let text
  try {
    text = readFileSync(path, 'utf8')
  } catch {
    return
  }
  for (const pattern of forbiddenTextPatterns) {
    if (pattern.test(text)) addForbidden(`${label} matched forbidden text pattern ${pattern}`)
  }
}

function shouldScanText(path) {
  return ['.json', '.toml', '.xml', '.txt', '.yml', '.yaml', '.gradle', '.kts'].includes(extname(path))
}

function redacted(path) {
  return path.replace(repoRoot, '<repo-root>')
}
