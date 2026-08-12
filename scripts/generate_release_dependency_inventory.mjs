#!/usr/bin/env node
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs'
import { basename, dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const scriptPath = fileURLToPath(import.meta.url)
const repoRoot = resolve(dirname(scriptPath), '..')
const packageRoot = join(repoRoot, 'apps', 'aurora-tauri')
const args = process.argv.slice(2)

const reportPath = resolve(readOption('--report') ?? join(packageRoot, 'reports', 'release-dependency-inventory.json'))
const actualHead = readGit(['rev-parse', 'HEAD'])
const sourceCommit = readOption('--source-commit') ?? actualHead
const blockers = []
const inputs = []
const allowedLicenseIds = new Map([
  ['0bsd', '0BSD'],
  ['afl-2.1', 'AFL-2.1'],
  ['apache-2.0', 'Apache-2.0'],
  ['blueoak-1.0.0', 'BlueOak-1.0.0'],
  ['bsd-1-clause', 'BSD-1-Clause'],
  ['bsd-2-clause', 'BSD-2-Clause'],
  ['bsd-3-clause', 'BSD-3-Clause'],
  ['bsl-1.0', 'BSL-1.0'],
  ['cc0-1.0', 'CC0-1.0'],
  ['cdla-permissive-2.0', 'CDLA-Permissive-2.0'],
  ['isc', 'ISC'],
  ['mit', 'MIT'],
  ['mit-0', 'MIT-0'],
  ['psf-2.0', 'PSF-2.0'],
  ['python-2.0', 'Python-2.0'],
  ['unicode-3.0', 'Unicode-3.0'],
  ['unlicense', 'Unlicense'],
  ['zlib', 'Zlib'],
])
const licenseAliases = new Map([
  ['3-clause bsd license', 'BSD-3-Clause'],
  ['apache 2.0', 'Apache-2.0'],
  ['apache license 2.0', 'Apache-2.0'],
  ['apache license, version 2.0', 'Apache-2.0'],
  ['apache software license', 'Apache-2.0'],
  ['bsd 2-clause license', 'BSD-2-Clause'],
  ['bsd 3-clause license', 'BSD-3-Clause'],
  ['license :: osi approved :: apache software license', 'Apache-2.0'],
  ['license :: osi approved :: mit license', 'MIT'],
  ['mit license', 'MIT'],
  ['modified bsd license', 'BSD-3-Clause'],
])
const allowedLicenseExceptions = new Map([
  ['llvm-exception', 'LLVM-exception'],
])
const secretTokenPatterns = [
  /ghp_[A-Za-z0-9_]{20,}/gu,
  /github_pat_[A-Za-z0-9_]{20,}/gu,
  /sk-[A-Za-z0-9_-]{20,}/gu,
  /xoxb-[A-Za-z0-9-]{20,}/gu,
  /AKIA[A-Z0-9]{16}/gu,
]

const paths = {
  packageJson: inputPath('--package-json', join(packageRoot, 'package.json')),
  rootPackageJson: inputPath('--root-package-json', join(repoRoot, 'package.json')),
  pnpmLock: inputPath('--pnpm-lock', join(repoRoot, 'pnpm-lock.yaml')),
  pyproject: inputPath('--pyproject', join(repoRoot, 'pyproject.toml')),
  uvLock: inputPath('--uv-lock', join(repoRoot, 'uv.lock')),
  cargoManifest: inputPath('--cargo-manifest', join(packageRoot, 'src-tauri', 'Cargo.toml')),
  cargoLock: inputPath('--cargo-lock', join(packageRoot, 'src-tauri', 'Cargo.lock')),
  phase4Manifest: inputPath('--phase4-manifest', join(repoRoot, 'tools', 'voice-runtime', 'phase4_manifest.json')),
}
const cargoMetadataJson = readOption('--cargo-metadata-json')
  ? inputPath('--cargo-metadata-json', readOption('--cargo-metadata-json'))
  : null
const pnpmLicensesJson = readOption('--pnpm-licenses-json')
  ? inputPath('--pnpm-licenses-json', readOption('--pnpm-licenses-json'))
  : null
const uvCyclonedxJson = readOption('--uv-cyclonedx-json')
  ? inputPath('--uv-cyclonedx-json', readOption('--uv-cyclonedx-json'))
  : null
const pythonMetadataJson = readOption('--python-metadata-json')
  ? inputPath('--python-metadata-json', readOption('--python-metadata-json'))
  : null

try {
  validateSourceCommit()
  for (const path of Object.values(paths)) recordInput(path)
  if (cargoMetadataJson) recordInput(cargoMetadataJson)
  if (pnpmLicensesJson) recordInput(pnpmLicensesJson)
  if (uvCyclonedxJson) recordInput(uvCyclonedxJson)
  if (pythonMetadataJson) recordInput(pythonMetadataJson)

  const inventory = [
    ...collectPnpmDependencies(),
    ...collectUvDependencies(),
    ...collectCargoDependencies(),
    ...collectPhase4Artifacts(),
  ].sort(compareInventoryItems)

  const duplicateIds = findDuplicates(inventory.map((item) => item.id))
  for (const id of duplicateIds) {
    blockers.push(blocker('duplicate-inventory-id', `Inventory id collision: ${id}`, { severity: 'high' }))
  }

  const dispositionCounts = countBy(inventory, (item) => item.disposition)
  const unknownLicenses = inventory.filter((item) => ['UNKNOWN', 'UNREVIEWED'].includes(item.license.id))
  const blockedLicenses = inventory.filter((item) => item.disposition !== 'allowed')
  if (unknownLicenses.length > 0) {
    blockers.push(blocker('unknown-license-metadata', `${unknownLicenses.length} inventory entries have unresolved license metadata.`, {
      severity: 'high',
      count: unknownLicenses.length,
    }))
  }
  if (blockedLicenses.length > 0) {
    blockers.push(blocker('blocked-license-disposition', `${blockedLicenses.length} inventory entries are blocked by static metadata.`, {
      severity: 'high',
      count: blockedLicenses.length,
    }))
  }

  const report = redact({
    schema: 'aurora.release-dependency-inventory.v1',
    generatedAt: new Date().toISOString(),
    source: {
      commit: actualHead,
      repository: 'aurora',
      dirtyTreeIncluded: false,
    },
    claimBoundary: {
      kind: 'static-metadata-only',
      legalApproval: false,
      binaryCompleteness: false,
      signingProof: false,
      storeProof: false,
      runtimeProof: false,
      modelQualityProof: false,
      physicalDeviceProof: false,
    },
    status: blockers.length > 0 ? 'blocked' : 'passed',
    releaseBlocked: blockers.length > 0,
    secretsRedacted: true,
    tools: collectToolVersions(),
    inputs: inputs.sort((a, b) => a.path.localeCompare(b.path)),
    summary: {
      totalEntries: inventory.length,
      ecosystems: countBy(inventory, (item) => item.ecosystem),
      dispositions: dispositionCounts,
    },
    blockers,
    inventory,
  })

  const redactionFailures = findRedactionFailures(report)
  if (redactionFailures.length > 0) {
    report.status = 'blocked'
    report.releaseBlocked = true
    report.secretsRedacted = false
    report.blockers.push(blocker('report-redaction', 'Report redaction probe found sensitive or absolute local data.', {
      severity: 'critical',
      tokens: redactionFailures,
    }))
  }

  writeAtomicJson(reportPath, report)
  if (report.releaseBlocked) {
    console.error(`Release dependency inventory blocked. Report: ${safeRel(reportPath)}`)
    for (const item of report.blockers) console.error(`- ${item.id}: ${item.detail}`)
    process.exit(1)
  }
  console.log(`Release dependency inventory passed. Report: ${safeRel(reportPath)}`)
} catch (error) {
  const message = error instanceof Error ? error.message : String(error)
  const report = redact({
    schema: 'aurora.release-dependency-inventory.v1',
    generatedAt: new Date().toISOString(),
    source: {
      commit: actualHead ?? 'unknown',
      repository: 'aurora',
      dirtyTreeIncluded: false,
    },
    claimBoundary: {
      kind: 'static-metadata-only',
      legalApproval: false,
      binaryCompleteness: false,
      signingProof: false,
      storeProof: false,
      runtimeProof: false,
      modelQualityProof: false,
      physicalDeviceProof: false,
    },
    status: 'blocked',
    releaseBlocked: true,
    secretsRedacted: true,
    tools: collectToolVersions(),
    inputs,
    summary: {
      totalEntries: 0,
      ecosystems: {},
      dispositions: {},
    },
    blockers: [blocker('inventory-generation-error', message, { severity: 'critical' })],
    inventory: [],
  })
  writeAtomicJson(reportPath, report)
  console.error(`Release dependency inventory blocked. Report: ${safeRel(reportPath)}`)
  console.error(`- inventory-generation-error: ${message}`)
  process.exit(1)
}

function collectPnpmDependencies() {
  const { value, raw, sourceRef } = readPnpmLicensesJson()
  const entries = []
  for (const [licenseGroup, packages] of Object.entries(value)) {
    if (!Array.isArray(packages)) continue
    for (const pkg of packages) {
      const versions = Array.isArray(pkg.versions) && pkg.versions.length > 0 ? pkg.versions : [pkg.version ?? 'UNKNOWN']
      for (const version of versions) {
        const licenseId = normalizeLicense(pkg.license ?? licenseGroup)
        entries.push(inventoryItem({
          ecosystem: 'npm',
          scope: 'production-transitive',
          name: String(pkg.name ?? 'unknown-package'),
          version: normalizeVersion(String(version)),
          source: 'pnpm-licenses',
          sourceRef,
          hash: normalizeHash(raw),
          license: licenseEvidence(licenseId, sourceRef, sha256(Buffer.from(raw, 'utf8'))),
          disposition: dispositionForLicense(licenseId),
        }))
      }
    }
  }
  if (entries.length === 0) {
    blockers.push(blocker('pnpm-license-inventory-empty', 'pnpm license inventory did not contain any production packages.', {
      severity: 'high',
    }))
  }
  return entries
}

function collectUvDependencies() {
  const { value, raw, sourceRef } = readUvCyclonedxJson()
  const metadata = readPythonMetadata()
  const components = Array.isArray(value.components) ? value.components : []
  if (components.length === 0) {
    blockers.push(blocker('uv-cyclonedx-inventory-empty', 'uv CycloneDX export did not contain any Python components.', {
      severity: 'high',
    }))
  }
  return components.map((component) => {
    const name = String(component.name ?? 'unknown-package')
    const version = String(component.version ?? 'UNKNOWN')
    const key = pythonMetadataKey(name, version)
    const metadataEntry = metadata.get(key) ?? metadata.get(pythonMetadataKey(name, null))
    const licenseId = normalizeLicense(componentLicense(component) ?? metadataEntry?.license)
    return inventoryItem({
      ecosystem: 'python',
      scope: 'all-extras-all-groups',
      name,
      version,
      source: 'uv-cyclonedx',
      sourceRef,
      hash: componentHash(component, raw),
      license: licenseEvidence(
        licenseId,
        metadataEntry ? 'importlib.metadata license/classifier' : sourceRef,
        metadataEntry?.evidenceHash ?? sha256(Buffer.from(raw, 'utf8')),
      ),
      disposition: dispositionForLicense(licenseId),
    })
  })
}

function collectCargoDependencies() {
  const metadata = cargoMetadataJson ? readJson(cargoMetadataJson) : readCargoMetadata()
  if (metadata?.packages) {
    return metadata.packages
      .filter((pkg) => !pkg.source || String(pkg.source).startsWith('registry+') || String(pkg.source).startsWith('path+'))
      .map((pkg) => {
        const licenseId = normalizeLicense(pkg.license)
        const source = pkg.source ? String(pkg.source).startsWith('path+') ? 'cargo-path' : 'cargo-registry' : 'cargo-workspace'
        const metadataRawHash = inputHash(cargoMetadataJson ?? paths.cargoLock)
        const packageChecksum = source === 'cargo-registry' ? cargoHashFor(pkg.name, pkg.version) : null
        if (source === 'cargo-registry' && !packageChecksum) {
          blockers.push(blocker('cargo-package-checksum-missing', `Cargo registry checksum is missing for ${pkg.name}@${pkg.version}.`, {
            severity: 'high',
          }))
        }
        return inventoryItem({
          ecosystem: 'cargo',
          scope: pkg.source ? 'locked' : 'workspace',
          name: pkg.name,
          version: pkg.version,
          source,
          sourceRef: safeCargoManifestPath(pkg.manifest_path),
          hash: packageChecksum ?? metadataRawHash,
          license: licenseEvidence(licenseId, 'cargo metadata package.license', metadataRawHash),
          disposition: dispositionForLicense(licenseId),
        })
      })
  }

  return parseCargoLockPackages(readText(paths.cargoLock)).map((pkg) => inventoryItem({
    ecosystem: 'cargo',
    scope: 'locked',
    name: pkg.name,
    version: pkg.version,
    source: 'cargo-lock',
    sourceRef: 'apps/aurora-tauri/src-tauri/Cargo.lock',
    hash: pkg.checksum ?? inputHash(paths.cargoLock),
    license: licenseEvidence('UNKNOWN', 'apps/aurora-tauri/src-tauri/Cargo.lock', inputHash(paths.cargoLock)),
    disposition: 'blocked',
  }))
}

function collectPhase4Artifacts() {
  const manifest = readJson(paths.phase4Manifest)
  const artifacts = Array.isArray(manifest.artifacts) ? manifest.artifacts : []
  return artifacts.map((artifact) => {
    const license = artifact.license && typeof artifact.license === 'object' ? artifact.license : {}
    const licenseId = normalizeLicense(license.spdx)
    const staticLicenseDisposition = dispositionForLicense(licenseId)
    return inventoryItem({
      ecosystem: 'phase4-native-voice',
      scope: String(artifact.status ?? 'unknown'),
      name: String(artifact.id ?? artifact.url ?? 'unknown-artifact'),
      version: String(artifact.version ?? artifact.commit ?? 'UNKNOWN'),
      source: String(artifact.kind ?? 'phase4-artifact'),
      sourceRef: 'tools/voice-runtime/phase4_manifest.json',
      hash: String(artifact.sha256 ?? inputHash(paths.phase4Manifest)),
      license: licenseEvidence(
        licenseId,
        String(license.evidence ?? 'tools/voice-runtime/phase4_manifest.json'),
        String(license.evidence_sha256 ?? inputHash(paths.phase4Manifest)),
      ),
      disposition: license.disposition === 'allowed' && staticLicenseDisposition === 'allowed' ? 'allowed' : 'blocked',
      role: artifact.role ? String(artifact.role) : undefined,
    })
  })
}

function collectToolVersions() {
  return [
    toolVersion('pnpm', ['--version']),
    toolVersion('uv', ['--version']),
    toolVersion('cargo', ['--version']),
  ].sort((a, b) => a.name.localeCompare(b.name))
}

function readPnpmLicensesJson() {
  if (pnpmLicensesJson) {
    const raw = readText(pnpmLicensesJson)
    return { value: JSON.parse(raw), raw, sourceRef: safeRel(pnpmLicensesJson) }
  }
  try {
    const raw = execFileSync('pnpm', ['--dir', 'apps/aurora-tauri', 'licenses', 'ls', '--prod', '--json', '--long'], {
      cwd: repoRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: 50 * 1024 * 1024,
    })
    inputs.push({
      path: 'pnpm licenses ls --prod --json --long',
      sha256: sha256(Buffer.from(raw, 'utf8')),
    })
    return { value: JSON.parse(raw), raw, sourceRef: 'pnpm licenses ls --prod --json --long' }
  } catch (error) {
    throw new Error('pnpm licenses ls --prod --json --long failed')
  }
}

function readUvCyclonedxJson() {
  if (uvCyclonedxJson) {
    const raw = readText(uvCyclonedxJson)
    return { value: JSON.parse(raw), raw, sourceRef: safeRel(uvCyclonedxJson) }
  }
  try {
    const raw = execFileSync('uv', [
      'export',
      '--frozen',
      '--format',
      'cyclonedx1.5',
      '--all-extras',
      '--all-groups',
    ], {
      cwd: repoRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: 100 * 1024 * 1024,
    })
    inputs.push({
      path: 'uv export --frozen --format cyclonedx1.5 --all-extras --all-groups',
      sha256: sha256(Buffer.from(raw, 'utf8')),
    })
    return { value: JSON.parse(raw), raw, sourceRef: 'uv export --frozen --format cyclonedx1.5 --all-extras --all-groups' }
  } catch {
    throw new Error('uv export --frozen --format cyclonedx1.5 --all-extras --all-groups failed')
  }
}

function readPythonMetadata() {
  const raw = pythonMetadataJson ? readText(pythonMetadataJson) : readPythonMetadataFromEnvironment()
  if (!raw) return new Map()
  const parsed = JSON.parse(raw)
  const entries = Array.isArray(parsed) ? parsed : Object.values(parsed)
  const map = new Map()
  for (const entry of entries) {
    if (!entry || typeof entry !== 'object') continue
    const name = String(entry.name ?? '')
    const version = entry.version ? String(entry.version) : null
    if (!name) continue
    const license = normalizeLicense(entry.license ?? entry.licenseExpression ?? entry.classifierLicense)
    const normalized = {
      license,
      evidenceHash: sha256(Buffer.from(JSON.stringify(entry), 'utf8')),
    }
    map.set(pythonMetadataKey(name, version), normalized)
    map.set(pythonMetadataKey(name, null), normalized)
  }
  if (pythonMetadataJson) {
    inputs.push({
      path: 'importlib.metadata fixture',
      sha256: inputHash(pythonMetadataJson),
    })
  }
  return map
}

function readPythonMetadataFromEnvironment() {
  const code = `
import importlib.metadata as metadata, json
rows = []
for dist in metadata.distributions():
    meta = dist.metadata
    classifiers = [c for c in meta.get_all("Classifier", []) if c.startswith("License ::")]
    rows.append({
        "name": meta.get("Name"),
        "version": meta.get("Version"),
        "license": meta.get("License") or " OR ".join(classifiers) or None,
        "classifierLicense": " OR ".join(classifiers) or None,
    })
print(json.dumps(rows, sort_keys=True))
`
  try {
    const raw = execFileSync('uv', ['run', '--frozen', 'python', '-c', code], {
      cwd: repoRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: 50 * 1024 * 1024,
    })
    inputs.push({
      path: 'uv run --frozen python importlib.metadata',
      sha256: sha256(Buffer.from(raw, 'utf8')),
    })
    return raw
  } catch {
    blockers.push(blocker('python-metadata-unavailable', 'importlib.metadata license data could not be read; Python licenses fail closed when absent from CycloneDX.', {
      severity: 'high',
    }))
    return null
  }
}

function componentLicense(component) {
  if (Array.isArray(component.licenses)) {
    const ids = component.licenses.map((entry) => entry?.license?.id ?? entry?.license?.name ?? entry?.expression).filter(Boolean)
    if (ids.length > 0) return ids.join(' OR ')
  }
  return null
}

function componentHash(component, raw) {
  if (Array.isArray(component.hashes)) {
    const sha = component.hashes.find((entry) => String(entry.alg ?? '').toLowerCase() === 'sha-256' && entry.content)
    if (sha) return `sha256:${sha.content}`
  }
  return sha256(Buffer.from(JSON.stringify(component) || raw, 'utf8'))
}

function pythonMetadataKey(name, version) {
  return `${name.toLowerCase()}@${version ?? '*'}`
}

function toolVersion(name, toolArgs) {
  try {
    return {
      name,
      available: true,
      version: execFileSync(name, toolArgs, {
        cwd: repoRoot,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim(),
    }
  } catch {
    return {
      name,
      available: false,
      version: null,
    }
  }
}

function readCargoMetadata() {
  try {
    const stdout = execFileSync('cargo', [
      'metadata',
      '--format-version',
      '1',
      '--locked',
      '--manifest-path',
      paths.cargoManifest,
    ], {
      cwd: repoRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: 50 * 1024 * 1024,
    })
    return JSON.parse(stdout)
  } catch (error) {
    blockers.push(blocker('cargo-metadata-unavailable', 'cargo metadata could not run; falling back to Cargo.lock with unknown licenses.', {
      severity: 'high',
    }))
    return null
  }
}

function parseCargoLockPackages(text) {
  const blocks = text.split(/\n(?=\[\[package\]\])/u).filter((block) => block.includes('[[package]]'))
  return blocks.map((block) => {
    const name = matchValue(block, /^name = "([^"]+)"/mu)
    const version = matchValue(block, /^version = "([^"]+)"/mu)
    const checksum = matchValue(block, /^checksum = "([a-f0-9]{64})"/mu)
    return name && version ? { name, version, checksum: checksum ? `sha256:${checksum}` : null } : null
  }).filter(Boolean)
}

function cargoHashFor(name, version) {
  const pkg = parseCargoLockPackages(readText(paths.cargoLock))
    .find((item) => item.name === name && item.version === version)
  return pkg?.checksum ?? null
}

function inventoryItem({
  ecosystem,
  scope,
  name,
  version,
  source,
  sourceRef,
  hash,
  license,
  disposition,
  role,
}) {
  const base = {
    id: stableId([ecosystem, scope, source, name, version]),
    ecosystem,
    scope,
    name,
    version: version ?? 'UNKNOWN',
    source,
    sourceRef: redactPath(sourceRef),
    hash: normalizeHash(hash),
    license,
    disposition: disposition === 'allowed' ? 'allowed' : 'blocked',
  }
  if (role) base.role = role
  return base
}

function licenseEvidence(id, evidence, evidenceHash) {
  return {
    id: normalizeLicense(id),
    evidence: redactPath(evidence),
    evidenceHash: normalizeHash(evidenceHash),
  }
}

function dispositionForLicense(id) {
  const normalized = normalizeLicense(id)
  return parseLicenseExpression(normalized)?.allowed === true ? 'allowed' : 'blocked'
}

function validateSourceCommit() {
  if (!actualHead) {
    throw new Error('git HEAD is unavailable')
  }
  if (!/^[a-f0-9]{7,40}$/u.test(sourceCommit)) {
    throw new Error('source commit must be a git commit hash')
  }
  if (actualHead && sourceCommit !== actualHead && !actualHead.startsWith(sourceCommit)) {
    throw new Error(`source commit mismatch: expected ${actualHead}, received ${sourceCommit}`)
  }
}

function inputPath(flag, fallback) {
  const supplied = readOption(flag)
  return resolve(supplied ?? fallback)
}

function recordInput(path) {
  validateInputPath(path)
  inputs.push({
    path: safeRel(path),
    sha256: sha256(readFileSync(path)),
  })
}

function validateInputPath(path) {
  let linkStats
  try {
    linkStats = lstatSync(path)
  } catch {
    throw new Error(`required input is missing: ${safeRel(path)}`)
  }
  if (linkStats.isSymbolicLink()) {
    throw new Error(`required input must not be a symlink: ${safeRel(path)}`)
  }
  if (!linkStats.isFile()) {
    throw new Error(`required input must be a regular file: ${safeRel(path)}`)
  }
}

function readJson(path) {
  return JSON.parse(readText(path))
}

function readText(path) {
  validateInputPath(path)
  return readFileSync(path, 'utf8')
}

function inputHash(path) {
  return sha256(readFileSync(path))
}

function readOption(name) {
  const index = args.lastIndexOf(name)
  if (index === -1) return null
  const value = args[index + 1]
  if (!value || value.startsWith('--')) throw new Error(`${name} requires a value`)
  return value
}

function readGit(gitArgs) {
  try {
    return execFileSync('git', gitArgs, {
      cwd: repoRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
  } catch {
    return null
  }
}

function safeCargoManifestPath(value) {
  if (!value) return 'apps/aurora-tauri/src-tauri/Cargo.toml'
  return redactPath(String(value).replace(/^file:\/\//u, ''))
}

function redactPath(value) {
  if (!value) return value
  const text = String(value)
  if (/^https?:\/\//u.test(text) || /^[a-z]+:/iu.test(text) && !text.startsWith(repoRoot)) return text
  if (text.startsWith(repoRoot)) return safeRel(text)
  if (text.startsWith('/')) return basename(text)
  return text
}

function safeRel(path) {
  const rel = relative(repoRoot, resolve(path))
  return rel && !rel.startsWith('..') && !rel.startsWith('/') ? rel : basename(path)
}

function normalizeVersion(value) {
  if (!value) return 'UNKNOWN'
  if (value.startsWith('link:')) return value
  return value.replace(/\(.+$/u, '')
}

function normalizeLicense(value) {
  const text = typeof value === 'string' ? value.trim() : ''
  if (!text) return 'UNKNOWN'
  if (text.toUpperCase() === 'UNKNOWN') return 'UNKNOWN'
  if (text.toUpperCase() === 'UNREVIEWED') return 'UNREVIEWED'
  const alias = licenseAliases.get(text.toLowerCase())
  if (alias) return alias
  if (text.length > 256 || /[\r\n]/u.test(text)) return 'UNREVIEWED'
  return parseLicenseExpression(text)?.canonical ?? 'UNREVIEWED'
}

function parseLicenseExpression(value) {
  if (!value || ['UNKNOWN', 'UNREVIEWED'].includes(value)) return null
  const prepared = String(value).replaceAll('/', ' OR ').trim()
  if (!prepared || !/^[A-Za-z0-9.+()\s-]+$/u.test(prepared)) return null
  const tokens = prepared.match(/\(|\)|[A-Za-z0-9][A-Za-z0-9.+-]*/gu) ?? []
  if (tokens.join('') !== prepared.replace(/\s+/gu, '')) return null

  let cursor = 0
  const parsePrimary = () => {
    if (tokens[cursor] === '(') {
      cursor += 1
      const nested = parseExpression()
      if (!nested || tokens[cursor] !== ')') return null
      cursor += 1
      return { canonical: `(${nested.canonical})`, allowed: nested.allowed }
    }

    const term = canonicalLicenseTerm(tokens[cursor])
    if (!term) return null
    cursor += 1
    if (String(tokens[cursor] ?? '').toUpperCase() !== 'WITH') return term
    cursor += 1
    const exception = allowedLicenseExceptions.get(String(tokens[cursor] ?? '').toLowerCase())
    if (!exception) return null
    cursor += 1
    return {
      canonical: `${term.canonical} WITH ${exception}`,
      allowed: term.allowed,
    }
  }

  const parseExpression = () => {
    let left = parsePrimary()
    if (!left) return null
    while (['AND', 'OR'].includes(String(tokens[cursor] ?? '').toUpperCase())) {
      const operator = String(tokens[cursor]).toUpperCase()
      cursor += 1
      const right = parsePrimary()
      if (!right) return null
      left = {
        canonical: `${left.canonical} ${operator} ${right.canonical}`,
        allowed: left.allowed && right.allowed,
      }
    }
    return left
  }

  const parsed = parseExpression()
  return parsed && cursor === tokens.length ? parsed : null
}

function canonicalLicenseTerm(value) {
  if (!value || ['AND', 'OR', 'WITH'].includes(String(value).toUpperCase())) return null
  const allowed = allowedLicenseIds.get(String(value).toLowerCase())
  if (allowed) return { canonical: allowed, allowed: true }
  const text = String(value)
  if (/^(?:(?:A?GPL|LGPL)(?:[-v]?\d.*)?|(?:MPL|EPL|SSPL|BUSL)-\d.*|CC-BY-NC(?:-.*)?|NONCOMMERCIAL|PROPRIETARY)$/iu.test(text)) {
    return { canonical: text, allowed: false }
  }
  return null
}

function normalizeHash(value) {
  const text = String(value ?? '')
  if (/^sha256:[a-f0-9]{64}$/u.test(text)) return text
  if (/^[a-f0-9]{64}$/u.test(text)) return `sha256:${text}`
  return `sha256:${sha256(Buffer.from(text || 'unknown', 'utf8'))}`
}

function matchValue(text, pattern) {
  return text.match(pattern)?.[1] ?? null
}

function blocker(id, detail, extra = {}) {
  return {
    id,
    detail,
    severity: extra.severity ?? 'medium',
    ...Object.fromEntries(Object.entries(extra).filter(([key]) => key !== 'severity')),
  }
}

function countBy(items, keyFn) {
  const counts = {}
  for (const item of items) {
    const key = keyFn(item)
    counts[key] = (counts[key] ?? 0) + 1
  }
  return Object.fromEntries(Object.entries(counts).sort(([a], [b]) => a.localeCompare(b)))
}

function findDuplicates(values) {
  const seen = new Set()
  const duplicates = new Set()
  for (const value of values) {
    if (seen.has(value)) duplicates.add(value)
    seen.add(value)
  }
  return [...duplicates].sort()
}

function compareInventoryItems(a, b) {
  return a.ecosystem.localeCompare(b.ecosystem) ||
    a.scope.localeCompare(b.scope) ||
    a.name.localeCompare(b.name) ||
    a.version.localeCompare(b.version) ||
    a.source.localeCompare(b.source)
}

function stableId(parts) {
  return parts.map((part) => String(part).toLowerCase().replace(/[^a-z0-9._-]+/gu, '-')).join(':')
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

function writeAtomicJson(path, value) {
  mkdirSync(dirname(path), { recursive: true })
  const tmp = `${path}.${process.pid}.tmp`
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
  renameSync(tmp, path)
}

function redact(value) {
  if (Array.isArray(value)) return value.map(redact)
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, redact(entry)]))
  }
  if (typeof value !== 'string') return value
  let redacted = value
    .replaceAll(repoRoot, '<repo>')
    .replaceAll(process.cwd(), '<cwd>')
    .replaceAll(process.env.HOME ?? '<no-home>', '<home>')
  for (const pattern of secretTokenPatterns) redacted = redacted.replace(pattern, '<redacted-token>')
  return redacted
}

function findRedactionFailures(report) {
  const serialized = JSON.stringify(report)
  const failures = []
  for (const token of [repoRoot, process.cwd(), process.env.HOME].filter(Boolean)) {
    if (token && serialized.includes(token)) failures.push('<absolute-path>')
  }
  if (/(?:ghp_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9_-]{20,}|xoxb-[A-Za-z0-9-]{20,}|AKIA[A-Z0-9]{16})/u.test(serialized)) failures.push('<secret-token-pattern>')
  return [...new Set(failures)].sort()
}
