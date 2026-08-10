#!/usr/bin/env node
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { isIP } from 'node:net'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const repoRoot = resolve(packageRoot, '..', '..')
const srcTauriRoot = join(packageRoot, 'src-tauri')
const args = process.argv.slice(2)

const reportPath = resolve(
  readOption('--report') ??
    join(packageRoot, 'reports', 'release-trust-policy.json'),
)
const expectedWorkflowCommand =
  readOption('--expected-workflow-command') ??
  'pnpm --dir apps/aurora-tauri run verify:static-release-trust-policy'
const expectedPackageScriptName = 'verify:static-release-trust-policy'
const expectedPackageScriptCommand = 'node scripts/assert-release-trust-policy.mjs'
const expectedTrustReportArtifactName = 'release-trust-policy'
const expectedTrustReportPath = 'apps/aurora-tauri/reports/release-trust-policy.json'
const nonPublicOrSpecialPurposeIPv4Ranges = [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.31.196.0', 24],
  ['192.52.193.0', 24],
  ['192.88.99.0', 24],
  ['192.168.0.0', 16],
  ['192.175.48.0', 24],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
]
const nonPublicOrSpecialPurposeIPv6Ranges = [
  ['::', 128],
  ['::1', 128],
  ['::', 96],
  ['::ffff:0:0', 96],
  ['64:ff9b::', 96],
  ['64:ff9b:1::', 48],
  ['100::', 64],
  ['2001::', 23],
  ['2001:db8::', 32],
  ['2002::', 16],
  ['5f00::', 16],
  ['fc00::', 7],
  ['fe80::', 10],
  ['ff00::', 8],
]

const paths = {
  packageJson: resolve(readOption('--package-json') ?? join(packageRoot, 'package.json')),
  tauriConfig: resolve(readOption('--config') ?? join(srcTauriRoot, 'tauri.conf.json')),
  capabilitiesDir: resolve(readOption('--capabilities-dir') ?? join(srcTauriRoot, 'capabilities')),
  workflow: resolve(readOption('--workflow') ?? join(repoRoot, '.github', 'workflows', 'release.yml')),
  androidBuildScript: resolve(
    readOption('--android-build-script') ?? join(packageRoot, 'scripts', 'build-android-client-bundle.mjs'),
  ),
  androidArtifactScript: resolve(
    readOption('--android-artifact-script') ?? join(packageRoot, 'scripts', 'assert-android-client-artifact-clean.mjs'),
  ),
  androidPreflightScript: resolve(
    readOption('--android-preflight-script') ?? join(packageRoot, 'scripts', 'android-preflight.mjs'),
  ),
  iosBuildScript: resolve(
    readOption('--ios-build-script') ?? join(packageRoot, 'scripts', 'build-ios-client-bundle.mjs'),
  ),
  iosEvidenceScript: resolve(
    readOption('--ios-evidence-script') ?? join(packageRoot, 'scripts', 'assert-ios-ci-evidence.mjs'),
  ),
  iosPreflightScript: resolve(
    readOption('--ios-preflight-script') ?? join(packageRoot, 'scripts', 'ios-preflight.mjs'),
  ),
}

const desktopOverlayPaths = readListOption('--desktop-overlay', [
  join(srcTauriRoot, 'tauri.linux.conf.json'),
  join(srcTauriRoot, 'tauri.macos.conf.json'),
  join(srcTauriRoot, 'tauri.windows.conf.json'),
])
const mobileOverlayPaths = readListOption('--mobile-overlay', [
  join(srcTauriRoot, 'tauri.ios.conf.json'),
  join(srcTauriRoot, 'tauri.ios-thin.conf.json'),
])

const blockers = []
const checks = []
const unsupportedChecks = [
  {
    id: 'android-artifact-hash',
    status: 'unsupported',
    releaseBlocking: true,
    detail: 'Android artifact byte-hash evidence is not proven by the current static policy gate.',
  },
  {
    id: 'ios-artifact-hash',
    status: 'unsupported',
    releaseBlocking: true,
    detail: 'iOS artifact byte-hash evidence is not proven by the current static policy gate.',
  },
  {
    id: 'sbom-license-tooling',
    status: 'unsupported',
    releaseBlocking: true,
    detail: 'Release SBOM and license inventory tooling is not wired into this static policy gate.',
  },
]
const checkedRefs = []

const config = readJson(paths.tauriConfig, 'tauri-config')
if (config.value) {
  checkedRefs.push(checkedRef('tauri-config', paths.tauriConfig, config.raw))
  validateUpdaterPolicy(config.value)
}

const updaterCapability = readJson(join(paths.capabilitiesDir, 'aurora-desktop-updater.json'), 'desktop-updater-capability')
if (updaterCapability.value) {
  checkedRefs.push(checkedRef('desktop-updater-capability', join(paths.capabilitiesDir, 'aurora-desktop-updater.json'), updaterCapability.raw))
  const permissions = list(updaterCapability.value.permissions)
  check(
    'desktop-updater-capability-permission',
    permissions.includes('updater:default'),
    'Desktop updater capability must grant updater:default.',
  )
}

for (const path of desktopOverlayPaths.map((value) => resolve(value))) {
  validateOverlay(path, 'desktop', { requiresUpdaterCapability: true })
}
for (const path of mobileOverlayPaths.map((value) => resolve(value))) {
  validateOverlay(path, 'mobile', { forbidsUpdaterCapability: true })
}

validateAndroidReleasePolicy()
validateIosReleasePolicy()
validatePackageScript()
validateWorkflowPlacement()

const redactionProbe = redactSensitiveValues({
  reportPath,
  checkedRefs,
  blockers,
  checks,
  unsupportedChecks,
})
const redactionFailures = containsSensitiveValue(redactionProbe)
if (redactionFailures.length) {
  blockers.push({
    id: 'report-redaction',
    detail: 'Static policy report would expose sensitive material.',
    severity: 'critical',
  })
  checks.push({
    id: 'report-redaction',
    status: 'blocked',
    detail: 'Sensitive material detected before writing report.',
  })
}

const releaseBlocked =
  blockers.length > 0 ||
  unsupportedChecks.some((item) => item.releaseBlocking === true && item.status !== 'passed')

const report = redactSensitiveValues({
  schema: 'aurora.release-trust-policy.v1',
  generatedAt: new Date().toISOString(),
  status: releaseBlocked ? 'blocked' : 'passed',
  claimBoundary: 'static-policy-only',
  signatureProof: false,
  storeProof: false,
  externalEvidenceRequired: true,
  releaseBlocked,
  checkedRefs,
  checks,
  blockers,
  unsupportedChecks,
  secretsRedacted: redactionFailures.length === 0,
})

writeAtomicJson(reportPath, report)

if (releaseBlocked) {
  console.error(`Release trust static policy blocked. Report: ${safeDisplayPath(reportPath)}`)
  for (const blocker of blockers) console.error(`- ${blocker.id}: ${blocker.detail}`)
  for (const unsupported of unsupportedChecks.filter((item) => item.releaseBlocking)) {
    console.error(`- ${unsupported.id}: ${unsupported.detail}`)
  }
  process.exit(1)
}

console.log(`Release trust static policy passed. Report: ${safeDisplayPath(reportPath)}`)

function validateUpdaterPolicy(value) {
  const updater = value.plugins?.updater
  const bundle = value.bundle ?? {}
  check('bundle-updater-artifacts', bundle.createUpdaterArtifacts === true, 'Tauri bundle.createUpdaterArtifacts must be true.')
  check('updater-config-present', Boolean(updater), 'Tauri updater plugin configuration must be present.')
  if (!updater) return

  const publicKey = String(updater.pubkey ?? '')
  check(
    'updater-public-key-plausible',
    isPlausiblePublicKey(publicKey),
    'Updater public key must be a non-placeholder production public key.',
  )

  const endpoints = list(updater.endpoints)
  check('updater-endpoints-present', endpoints.length > 0, 'Updater endpoints must be declared.')
  endpoints.forEach((endpoint, index) => {
    check(
      `updater-endpoint-${index + 1}-https-production`,
      isProductionHttpsEndpoint(endpoint),
      'Updater endpoint must be HTTPS and must not use placeholder, example, local, or special-purpose literal hosts.',
    )
  })
}

function validateOverlay(path, surface, policy) {
  const loaded = readJson(path, `${surface}-overlay`)
  if (!loaded.value) return
  checkedRefs.push(checkedRef(`${surface}-overlay`, path, loaded.raw))
  const capabilities = flattenCapabilityRefs(loaded.value.app?.security?.capabilities ?? [])
  const permissions = new Set()
  for (const capability of capabilities) {
    if (typeof capability !== 'string') {
      for (const permission of list(capability.permissions)) permissions.add(permission)
      continue
    }
    const capabilityPath = join(paths.capabilitiesDir, `${capability}.json`)
    const capabilityJson = readJson(capabilityPath, `capability:${capability}`, { optional: true })
    if (capabilityJson.value) {
      checkedRefs.push(checkedRef(`capability:${capability}`, capabilityPath, capabilityJson.raw))
      for (const permission of list(capabilityJson.value.permissions)) permissions.add(permission)
    }
  }

  if (policy.requiresUpdaterCapability) {
    check(
      `${safeId(path)}-desktop-updater-capability`,
      capabilities.includes('aurora-desktop-updater'),
      'Desktop overlays must include aurora-desktop-updater.',
    )
    check(
      `${safeId(path)}-desktop-updater-permission`,
      permissions.has('updater:default'),
      'Desktop overlays must resolve updater:default permission.',
    )
  }
  if (policy.forbidsUpdaterCapability) {
    check(
      `${safeId(path)}-mobile-no-updater-capability`,
      !capabilities.includes('aurora-desktop-updater') && !permissions.has('updater:default'),
      'Mobile overlays must not include desktop updater capability or updater:default permission.',
    )
  }
}

function validateAndroidReleasePolicy() {
  const build = readText(paths.androidBuildScript, 'android-build-script')
  const artifact = readText(paths.androidArtifactScript, 'android-artifact-script')
  const preflight = readText(paths.androidPreflightScript, 'android-preflight-script')
  if (build.ok) checkedRefs.push(checkedRef('android-build-script', paths.androidBuildScript, build.text))
  if (artifact.ok) checkedRefs.push(checkedRef('android-artifact-script', paths.androidArtifactScript, artifact.text))
  if (preflight.ok) checkedRefs.push(checkedRef('android-preflight-script', paths.androidPreflightScript, preflight.text))

  checkEverySource('android-config-hash', [build.text, artifact.text], [/createHash\(['"]sha256['"]\)/, /configSha256/], 'Android provenance must hash and verify generated config snapshots.')
  checkSource('android-redaction', [build.text, artifact.text, preflight.text], [/secretsRedacted\s*:\s*true/, /redacted\(/], 'Android release scripts must record redacted evidence only.')
  checkSource('android-strict-signing-policy', [preflight.text], [/--strict|const strict/, /ANDROID_KEYSTORE_PATH|TAURI_ANDROID_KEYSTORE_PATH|AURORA_ANDROID_SIGNING_CONFIGURED/], 'Android release policy must have a strict credential-gated signing surface.')
}

function validateIosReleasePolicy() {
  const build = readText(paths.iosBuildScript, 'ios-build-script')
  const evidence = readText(paths.iosEvidenceScript, 'ios-evidence-script')
  const preflight = readText(paths.iosPreflightScript, 'ios-preflight-script')
  if (build.ok) checkedRefs.push(checkedRef('ios-build-script', paths.iosBuildScript, build.text))
  if (evidence.ok) checkedRefs.push(checkedRef('ios-evidence-script', paths.iosEvidenceScript, evidence.text))
  if (preflight.ok) checkedRefs.push(checkedRef('ios-preflight-script', paths.iosPreflightScript, preflight.text))

  checkSource('ios-config-hash', [build.text], [/createHash\(['"]sha256['"]\)/, /configSha256/], 'iOS provenance must hash generated config snapshots.')
  checkSource('ios-redaction', [build.text, evidence.text, preflight.text], [/secretsRedacted\s*[:=]\s*true/, /redacted\(/], 'iOS release scripts must record redacted evidence only.')
  checkSource('ios-strict-signing-policy', [preflight.text], [/--require-signing-env|requireSigningEnv/, /APPLE_API_KEY_ID|APPLE_API_ISSUER|APPLE_API_KEY_PATH|APPLE_API_PRIVATE_KEY/], 'iOS release policy must have a strict credential-gated signing surface.')
}

function validateWorkflowPlacement() {
  const workflow = readText(paths.workflow, 'release-workflow')
  if (!workflow.ok) return
  checkedRefs.push(checkedRef('release-workflow', paths.workflow, workflow.text))
  const workflowStructure = inspectReleaseReadinessWorkflow(workflow.text)
  check(
    'workflow-create-release-needs-readiness',
    workflowStructure.createReleaseErrors.length === 0,
    'Release workflow must have exactly one canonical create-release job gated by release-readiness success and dry-run=false.',
  )
  check(
    'workflow-jobs-local-only',
    workflowStructure.localJobErrors.length === 0,
    'Release workflow jobs must be local jobs and must not use reusable workflow shortcuts.',
  )
  check(
    'workflow-trust-report-path-canonical',
    !workflowStructure.hasTrustReportEnvOverride,
    'Release workflow must not override the canonical trust policy report path.',
  )
  check(
    'workflow-release-readiness-unique-structure',
    workflowStructure.duplicateErrors.length === 0,
    'Release workflow must not contain duplicate or ambiguous release-readiness structure, job controls, or shell defaults.',
  )
  const steps = workflowStructure.steps
  check(
    'workflow-release-readiness-unique-step-keys',
    steps.every((step) => step.duplicateErrors.length === 0),
    'Release workflow steps must not contain duplicate direct fields or duplicate artifact upload fields.',
  )
  const commandStepIndex = steps.findIndex((step) => isCanonicalTrustGateStep(step))
  const trustUploadIndexes = steps
    .map((step, index) => isTrustReportUploadCandidate(step) ? index : -1)
    .filter((index) => index >= 0)
  const reportUploadStepIndex = trustUploadIndexes[0] ?? -1
  const semanticReleaseStepIndexes = steps
    .map((step, index) => stepRunsSemanticReleaseVersion(step) ? index : -1)
    .filter((index) => index >= 0)
  const semverStepIndex = semanticReleaseStepIndexes[0] ?? -1
  check(
    'workflow-trust-gate-first-run',
    commandStepIndex >= 0 &&
      hasCanonicalPregateSetupSequence(steps.slice(0, commandStepIndex)),
    'Release workflow must make the trust gate the first run step after the exact canonical setup sequence.',
  )
  check(
    'workflow-trust-gate-before-semver',
    commandStepIndex >= 0 &&
      semverStepIndex >= 0 &&
      commandStepIndex < semverStepIndex,
    'Release workflow must execute the trust policy gate in release-readiness before semantic versioning.',
  )
  check(
    'workflow-trust-report-upload-always',
    commandStepIndex >= 0 &&
      trustUploadIndexes.length === 1 &&
      isTrustReportUploadStep(steps[reportUploadStepIndex]) &&
      semverStepIndex >= 0 &&
      reportUploadStepIndex === commandStepIndex + 1 &&
      reportUploadStepIndex < semverStepIndex &&
      !steps.some((step, index) => index !== commandStepIndex && stepMutatesTrustReport(step)),
    'Release workflow must upload the trust policy report with if: always() immediately after the trust gate.',
  )
}

function validatePackageScript() {
  const packageJson = readJson(paths.packageJson, 'tauri-package-json')
  if (!packageJson.value) return
  checkedRefs.push(checkedRef('tauri-package-json', paths.packageJson, packageJson.raw))
  check(
    'package-static-release-trust-policy-script',
    packageJson.value.scripts?.[expectedPackageScriptName] === expectedPackageScriptCommand,
    `Package script ${expectedPackageScriptName} must run the static release trust policy guard.`,
  )
}

function checkSource(id, texts, patterns, detail) {
  const sources = texts.map((text) => stripNonExecutableSource(text))
  const passed = patterns.every((pattern) => sources.some((text) => pattern.test(text)))
  check(id, passed, detail)
}

function checkEverySource(id, texts, patterns, detail) {
  const sources = texts.map((text) => stripNonExecutableSource(text))
  const passed = sources.every((text) => patterns.every((pattern) => pattern.test(text)))
  check(id, passed, detail)
}

function check(id, passed, detail) {
  checks.push({ id, status: passed ? 'passed' : 'blocked', detail })
  if (!passed) blockers.push({ id, detail, severity: 'release-blocking' })
}

function readJson(path, label, options = {}) {
  const text = readText(path, label, options)
  if (!text.ok) return { value: null, raw: '' }
  try {
    return { value: JSON.parse(text.text), raw: text.text }
  } catch (error) {
    check(`${safeId(label)}-parse`, false, `${label} must be valid JSON.`)
    return { value: null, raw: '' }
  }
}

function readText(path, label, options = {}) {
  if (!existsSync(path)) {
    if (!options.optional) check(`${safeId(label)}-present`, false, `${label} must exist.`)
    return { ok: false, text: '' }
  }
  try {
    return { ok: true, text: readFileSync(path, 'utf8') }
  } catch {
    check(`${safeId(label)}-readable`, false, `${label} must be readable.`)
    return { ok: false, text: '' }
  }
}

function isPlausiblePublicKey(value) {
  const trimmed = value.trim()
  if (!trimmed || trimmed.length % 4 !== 0) return false
  if (/replace|placeholder|example|dummy|todo|changeme|local/i.test(trimmed)) return false
  if (/private\s+key/i.test(trimmed)) return false
  const publicKeyFile = decodeBase64Utf8(trimmed)
  if (publicKeyFile === null) return false
  const publicKeyLine = publicKeyFile.split(/\r?\n/)[1]?.trim() ?? ''
  const publicKey = decodeBase64(publicKeyLine)
  if (!publicKey || publicKey.length !== 42) return false
  const algorithm = publicKey.subarray(0, 2).toString('ascii')
  if (algorithm !== 'Ed' && algorithm !== 'ED') return false
  const keyId = publicKey.subarray(2, 10)
  const keyMaterial = publicKey.subarray(10)
  return !hasLowEntropyBytes(keyId) && !hasLowEntropyBytes(keyMaterial)
}

function decodeBase64Utf8(value) {
  const decoded = decodeBase64(value)
  if (!decoded) return null
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(decoded)
  } catch {
    return null
  }
}

function decodeBase64(value) {
  const normalized = String(value).trim()
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(normalized) || normalized.length % 4 !== 0) return null
  const decoded = Buffer.from(normalized, 'base64')
  if (!decoded.length || decoded.toString('base64') !== normalized) return null
  return decoded
}

function isProductionHttpsEndpoint(value) {
  if (typeof value !== 'string') return false
  if (/placeholder/i.test(value)) return false
  try {
    const url = new URL(value)
    const hostname = normalizeEndpointHostname(url.hostname)
    return url.protocol === 'https:' &&
      Boolean(hostname) &&
      !isReservedDnsHost(hostname) &&
      !isNonPublicOrSpecialPurposeHost(hostname)
  } catch {
    return false
  }
}

function normalizeEndpointHostname(value) {
  const hostname = value.toLowerCase()
  return hostname.endsWith('.') ? hostname.slice(0, -1) : hostname
}

function isReservedDnsHost(value) {
  const host = value.replace(/^\[|\]$/g, '')
  return [
    'alt',
    'example',
    'example.com',
    'example.net',
    'example.org',
    'home.arpa',
    'invalid',
    'local',
    'localhost',
    'onion',
    'test',
  ].some((suffix) => host === suffix || host.endsWith(`.${suffix}`))
}

function isNonPublicOrSpecialPurposeHost(value) {
  const host = value.replace(/^\[|\]$/g, '').replace(/%.*$/, '').toLowerCase()
  if (host === 'localhost') return true
  if (isIP(host) === 4) return isNonPublicOrSpecialPurposeIPv4(host)
  if (isIP(host) === 6) return isNonPublicOrSpecialPurposeIPv6(host)
  return false
}

function isNonPublicOrSpecialPurposeIPv4(value) {
  const parts = parseIPv4Bytes(value)
  if (!parts) return true
  const asInt = ipv4BytesToInt(parts)
  return nonPublicOrSpecialPurposeIPv4Ranges.some(([rangeStart, prefixLength]) =>
    isIPv4InRange(asInt, parseIPv4Bytes(rangeStart), prefixLength))
}

function isNonPublicOrSpecialPurposeIPv6(value) {
  const segments = expandIPv6(value)
  if (!segments) return true
  return nonPublicOrSpecialPurposeIPv6Ranges.some(([rangeStart, prefixLength]) =>
    isIPv6InRange(segments, expandIPv6(rangeStart), prefixLength))
}

function expandIPv6(value) {
  const [leftText, rightText = ''] = value.split('::')
  if (value.split('::').length > 2) return null
  const left = parseIPv6Part(leftText)
  const right = parseIPv6Part(rightText)
  if (!left || !right) return null
  const missing = 8 - left.length - right.length
  if (missing < 0 || (!value.includes('::') && missing !== 0)) return null
  return [...left, ...Array.from({ length: missing }, () => 0), ...right]
}

function parseIPv6Part(value) {
  if (!value) return []
  const parts = value.split(':')
  const segments = []
  for (const part of parts) {
    if (!part) return null
    if (part.includes('.')) {
      const bytes = parseIPv4Bytes(part)
      if (!bytes) return null
      segments.push((bytes[0] << 8) + bytes[1], (bytes[2] << 8) + bytes[3])
      continue
    }
    if (!/^[0-9a-f]{1,4}$/i.test(part)) return null
    segments.push(Number.parseInt(part, 16))
  }
  return segments
}

function parseIPv4Bytes(value) {
  const parts = value.split('.').map((part) => Number(part))
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
    return null
  }
  return parts
}

function ipv4BytesToInt(parts) {
  return (((parts[0] << 24) >>> 0) + (parts[1] << 16) + (parts[2] << 8) + parts[3]) >>> 0
}

function isIPv4InRange(value, rangeStart, prefixLength) {
  const mask = prefixLength === 0 ? 0 : (0xffffffff << (32 - prefixLength)) >>> 0
  return (value & mask) === (ipv4BytesToInt(rangeStart) & mask)
}

function isIPv6InRange(value, rangeStart, prefixLength) {
  let remaining = prefixLength
  for (let index = 0; index < 8; index += 1) {
    if (remaining <= 0) return true
    const segmentBits = Math.min(16, remaining)
    const mask = segmentBits === 16 ? 0xffff : (0xffff << (16 - segmentBits)) & 0xffff
    if ((value[index] & mask) !== (rangeStart[index] & mask)) return false
    remaining -= segmentBits
  }
  return true
}

function checkedRef(id, path, content) {
  return {
    id,
    ref: safeDisplayPath(path),
    sha256: createHash('sha256').update(content).digest('hex'),
  }
}

function readOption(name) {
  const index = args.indexOf(name)
  return index === -1 ? null : args[index + 1]
}

function readListOption(name, defaults) {
  const values = []
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === name && args[index + 1]) values.push(...args[index + 1].split(','))
  }
  return (values.length ? values : defaults).filter(Boolean)
}

function flattenCapabilityRefs(value) {
  return list(value).map((capability) => {
    if (typeof capability === 'string') return capability
    return capability && typeof capability === 'object' ? capability : String(capability)
  })
}

function list(value) {
  return Array.isArray(value) ? value : []
}

function safeId(value) {
  return String(value).replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '').toLowerCase() || 'value'
}

function safeDisplayPath(path) {
  const resolved = resolve(path)
  if (resolved.startsWith(repoRoot)) return `<repo-root>/${relative(repoRoot, resolved).replace(/\\/g, '/')}`
  if (resolved.startsWith(packageRoot)) return `<package-root>/${relative(packageRoot, resolved).replace(/\\/g, '/')}`
  return `<external>/${safeId(resolved).slice(-32)}`
}

function writeAtomicJson(path, value) {
  mkdirSync(dirname(path), { recursive: true })
  const temporaryPath = `${path}.tmp`
  writeFileSync(temporaryPath, `${JSON.stringify(value, null, 2)}\n`)
  renameSync(temporaryPath, path)
}

function redactSensitiveValues(value, parentKey = '') {
  if (Array.isArray(value)) return value.map((item) => redactSensitiveValues(item, parentKey))
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        isSensitiveKey(key) ? '<redacted>' : redactSensitiveValues(item, key),
      ]),
    )
  }
  if (typeof value === 'string') {
    if (isSensitiveKey(parentKey)) return '<redacted>'
    return value
      .replace(/-----BEGIN [^-]+-----[\s\S]*?-----END [^-]+-----/g, '<redacted>')
      .replace(/\b(?:sk|pk|ghp|gho|github_pat|AKIA)[A-Za-z0-9_:-]{12,}\b/g, '<redacted>')
      .replace(/\b[A-Za-z0-9+/]{80,}={0,2}\b/g, '<redacted>')
  }
  return value
}

function isSensitiveKey(key) {
  if (/^secretsRedacted$/i.test(key)) return false
  return /secret|token|password|private|keystore|credential|bearer|api[_-]?key|pubkey/i.test(key)
}

function hasLowEntropyBytes(bytes) {
  if (bytes.every((byte) => byte === 0)) return true
  if (new Set(bytes).size <= 2) return true
  for (let period = 1; period <= Math.floor(bytes.length / 2); period += 1) {
    if (bytes.every((byte, index) => byte === bytes[index % period])) return true
  }
  return false
}

function stripNonExecutableSource(text) {
  let output = ''
  let state = 'code'
  let quote = ''
  let escaped = false
  let previousCodeChar = ''
  let stringContent = ''
  let stringOutputStart = 0
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]
    const next = text[index + 1] ?? ''
    if (state === 'line-comment') {
      output += char === '\n' ? '\n' : ' '
      if (char === '\n') state = 'code'
      continue
    }
    if (state === 'block-comment') {
      output += char === '\n' ? '\n' : ' '
      if (char === '*' && next === '/') {
        output += ' '
        index += 1
        state = 'code'
      }
      continue
    }
    if (state === 'triple-string') {
      output += char === '\n' ? '\n' : ' '
      if (char === '"' && next === '"' && text[index + 2] === '"') {
        output += '  '
        index += 2
        state = 'code'
      }
      continue
    }
    if (state === 'string' || state === 'template' || state === 'regex') {
      output += char === '\n' ? '\n' : ' '
      if (escaped) {
        if (state === 'string') stringContent += char
        escaped = false
      } else if (char === '\\') {
        if (state === 'string') stringContent += char
        escaped = true
      } else if ((state === 'string' && char === quote) || (state === 'template' && char === '`')) {
        if (state === 'string' && stringContent === 'sha256') {
          output = `${output.slice(0, stringOutputStart)}"${stringContent}"${output.slice(stringOutputStart + stringContent.length + 2)}`
        }
        state = 'code'
      } else if (state === 'regex' && char === '/') {
        state = 'code'
      } else if (state === 'string') {
        stringContent += char
      }
      continue
    }
    output += char
    if (char === '"' || char === "'") {
      output = output.slice(0, -1) + ' '
      if (char === '"' && next === '"' && text[index + 2] === '"') {
        output += '  '
        index += 2
        state = 'triple-string'
      } else {
        state = 'string'
        quote = char
        stringContent = ''
        stringOutputStart = output.length - 1
      }
    } else if (char === '`') {
      output = output.slice(0, -1) + ' '
      state = 'template'
    } else if (char === '/' && next === '/') {
      output = output.slice(0, -1) + ' '
      state = 'line-comment'
      index += 1
    } else if (char === '/' && next === '*') {
      output = output.slice(0, -1) + ' '
      state = 'block-comment'
      index += 1
    } else if (char === '/' && isRegexStart(previousCodeChar)) {
      output = output.slice(0, -1) + ' '
      state = 'regex'
    }
    if (!/\s/.test(char) && state === 'code') previousCodeChar = char
  }
  return output
}

function isRegexStart(previousCodeChar) {
  return !previousCodeChar || /[({[=,:;!&|?+\-*~^<>]/.test(previousCodeChar)
}

function parseReleaseReadinessSteps(text) {
  return inspectReleaseReadinessWorkflow(text).steps
}

function inspectReleaseReadinessWorkflow(text) {
  const lines = text.split('\n')
  const duplicateErrors = []
  const createReleaseErrors = []
  const localJobErrors = []
  const topLevelJobs = findTopLevelKeyBlocks(lines, 'jobs')
  if (topLevelJobs.length > 1) duplicateErrors.push('top-level-jobs')
  if (hasUnsupportedTopLevelKeySyntax(lines)) duplicateErrors.push('unsupported-yaml-key-syntax')
  const hasTrustReportEnvOverride = hasWorkflowTrustReportEnvOverride(lines)
  if (findTopLevelKeyBlocks(lines, 'env').length > 0) duplicateErrors.push('workflow-env')
  const topLevelDefaults = findTopLevelKeyBlocks(lines, 'defaults')
  if (topLevelDefaults.length > 0) duplicateErrors.push('workflow-defaults')
  const topLevelPermissions = findTopLevelKeyBlocks(lines, 'permissions')
  if (!hasCanonicalWorkflowPermissions(lines, topLevelPermissions)) duplicateErrors.push('workflow-permissions')
  const jobs = topLevelJobs[0]
  if (!jobs) return { steps: [], duplicateErrors, createReleaseErrors, localJobErrors, hasTrustReportEnvOverride }

  if (hasUnsupportedDirectChildKeySyntax(lines, jobs.start + 1, jobs.end, jobs.indent)) {
    duplicateErrors.push('unsupported-jobs-key-syntax')
  }
  const directJobs = findDirectChildKeyBlocks(lines, jobs.start + 1, jobs.end, jobs.indent)
  duplicateErrors.push(...duplicateKeys(directJobs.map((block) => block.key)).map((key) => `job:${key}`))
  localJobErrors.push(...inspectLocalJobStructure(lines, directJobs))
  createReleaseErrors.push(...inspectReleaseProducingJobs(lines, directJobs))
  const readinessBlocks = directJobs.filter((block) => block.key === 'release-readiness')
  const readiness = readinessBlocks[0]
  if (!readiness) return { steps: [], duplicateErrors, createReleaseErrors, localJobErrors, hasTrustReportEnvOverride }

  if (hasUnsupportedDirectChildKeySyntax(lines, readiness.start + 1, readiness.end, readiness.indent)) {
    duplicateErrors.push('unsupported-release-readiness-key-syntax')
  }
  const directReadinessKeys = findDirectChildKeyBlocks(lines, readiness.start + 1, readiness.end, readiness.indent)
  duplicateErrors.push(...duplicateKeys(directReadinessKeys.map((block) => block.key)).map((key) => `release-readiness:${key}`))
  if (!hasCanonicalReleaseReadinessJobShape(lines, readiness, directReadinessKeys)) {
    duplicateErrors.push('release-readiness:job-shape')
  }
  const stepsBlocks = directReadinessKeys.filter((block) => block.key === 'steps')
  const steps = stepsBlocks[0]
  if (!steps) return { steps: [], duplicateErrors, createReleaseErrors, localJobErrors, hasTrustReportEnvOverride }

  return {
    steps: parseSteps(lines, steps.start + 1, steps.end, steps.indent),
    duplicateErrors,
    createReleaseErrors,
    localJobErrors,
    hasTrustReportEnvOverride,
  }
}

function findTopLevelKeyBlocks(lines, key) {
  const blocks = []
  for (let index = 0; index < lines.length; index += 1) {
    const code = stripYamlComment(lines[index])
    if (!code.trim()) continue
    const indent = indentationOf(code)
    if (indent !== 0) continue
    const parsedKey = parseYamlMappingKey(code)
    if (parsedKey?.unsupported) continue
    if (parsedKey?.key !== key) continue
    blocks.push({ key, value: parsedKey.value.trim(), start: index, end: findBlockEnd(lines, index + 1, lines.length, indent), indent })
  }
  return blocks
}

function findDirectChildKeyBlock(lines, start, end, parentIndent, key) {
  return findDirectChildKeyBlocks(lines, start, end, parentIndent).find((block) => block.key === key) ?? null
}

function findDirectChildKeyBlocks(lines, start, end, parentIndent) {
  const blocks = []
  const childIndent = directChildIndent(lines, start, end, parentIndent)
  if (childIndent === null) return blocks
  for (let index = start; index < end; index += 1) {
    const code = stripYamlComment(lines[index])
    if (!code.trim()) continue
    const indent = indentationOf(code)
    if (indent <= parentIndent) break
    if (indent !== childIndent) continue
    const parsedKey = parseYamlMappingKey(code)
    if (!parsedKey || parsedKey.unsupported) continue
    blocks.push({ key: parsedKey.key, value: parsedKey.value.trim(), start: index, end: findBlockEnd(lines, index + 1, end, indent), indent })
  }
  return blocks
}

function inspectReleaseProducingJobs(lines, directJobs) {
  if (!exactKeySet(directJobs.map((job) => job.key), ['release-readiness', 'create-release'])) {
    return ['release-jobs:canonical-job-set']
  }
  const releaseJobs = directJobs.filter((job) => job.key === 'create-release' || jobContainsReleaseSignal(lines, job))
  const createReleaseJobs = releaseJobs.filter((job) => job.key === 'create-release')
  const errors = []
  if (releaseJobs.length !== 1 || createReleaseJobs.length !== 1) errors.push('release-jobs:canonical-create-release')
  if (createReleaseJobs.length === 1) errors.push(...inspectCreateReleaseJob(lines, createReleaseJobs[0]))
  return errors
}

function inspectLocalJobStructure(lines, directJobs) {
  const errors = []
  for (const job of directJobs) {
    const keys = findDirectChildKeyBlocks(lines, job.start + 1, job.end, job.indent)
    if (keys.some((block) => block.key === 'uses' || block.key === 'secrets')) errors.push(`job:${job.key}:reusable`)
    if (job.key === 'create-release') {
      if (keys.some((block) => block.key === 'strategy' || block.key === 'matrix')) errors.push('create-release:matrix')
      if (!keys.some((block) => block.key === 'steps')) errors.push('create-release:steps')
    }
  }
  return errors
}

function inspectCreateReleaseJob(lines, createRelease) {
  const errors = []
  const keys = findDirectChildKeyBlocks(lines, createRelease.start + 1, createRelease.end, createRelease.indent)
  errors.push(...duplicateKeys(keys.map((block) => block.key)).map((key) => `create-release:${key}`))
  if (!hasCanonicalCreateReleaseJobShape(lines, createRelease, keys)) {
    errors.push('create-release:job-shape')
  }
  const needs = keys.filter((block) => block.key === 'needs')
  if (needs.length !== 1 || unquoteYamlScalar(needs[0].value.trim()) !== 'release-readiness') {
    errors.push('create-release:needs')
  }
  const ifBlocks = keys.filter((block) => block.key === 'if')
  if (ifBlocks.length !== 1 || !isCanonicalCreateReleaseCondition(ifBlocks[0].value)) {
    errors.push('create-release:if')
  }
  const steps = parseStepsFromBlock(lines, createRelease)
  const semanticReleaseActions = steps.filter((step) => isSemanticReleaseAction(step.uses))
  if (
    !hasCanonicalCreateReleaseSteps(steps) ||
    semanticReleaseActions.length !== 1 ||
    !isCanonicalPythonSemanticReleaseAction(semanticReleaseActions[0].uses)
  ) {
    errors.push('create-release:semantic-release-action')
  }
  return errors
}

function jobContainsReleaseSignal(lines, job) {
  return parseStepsFromBlock(lines, job).some((step) =>
    isSemanticReleaseAction(step.uses) ||
    step.runCommands.some((command) => commandRunsSemanticReleasePublish(command)))
}

function parseStepsFromBlock(lines, block) {
  const stepsBlock = findDirectChildKeyBlock(lines, block.start + 1, block.end, block.indent, 'steps')
  return stepsBlock ? parseSteps(lines, stepsBlock.start + 1, stepsBlock.end, stepsBlock.indent) : []
}

function isCanonicalCreateReleaseCondition(value) {
  const normalized = normalizeGitHubExpression(unquoteYamlScalar(String(value).trim()))
  return normalized === 'success()&&inputs.dry_run==false'
}

function normalizeGitHubExpression(value) {
  return String(value).trim().replace(/^\$\{\{\s*/, '').replace(/\s*\}\}$/, '').replace(/\s+/g, '')
}

function hasWorkflowTrustReportEnvOverride(lines) {
  return lines.some((line) => {
    const code = stripYamlComment(line)
    if (/\bAURORA_RELEASE_TRUST_POLICY_REPORT\b/.test(code)) return true
    return yamlLineContainsKey(code, 'AURORA_RELEASE_TRUST_POLICY_REPORT')
  })
}

function yamlLineContainsKey(line, targetKey) {
  const text = String(line)
  for (let index = 0; index < text.length; index += 1) {
    if (!/[A-Za-z_'"!]/.test(text[index])) continue
    const previous = text.slice(0, index).trimEnd()
    if (previous && !/[{,\s]$/.test(previous)) continue
    const parsed = parseYamlMappingKey(text.slice(index))
    if (parsed?.key === targetKey) return true
  }
  return false
}

function hasDefaultsRunShell(lines, start, end, defaultsIndent) {
  const runBlock = findDirectChildKeyBlock(lines, start, end, defaultsIndent, 'run')
  return Boolean(runBlock && findDirectChildKeyBlock(lines, runBlock.start + 1, runBlock.end, runBlock.indent, 'shell'))
}

function directChildIndent(lines, start, end, parentIndent) {
  for (let index = start; index < end; index += 1) {
    const code = stripYamlComment(lines[index])
    if (!code.trim()) continue
    const indent = indentationOf(code)
    if (indent <= parentIndent) return null
    return indent
  }
  return null
}

function duplicateKeys(values) {
  const seen = new Set()
  const duplicates = new Set()
  for (const value of values) {
    if (seen.has(value)) duplicates.add(value)
    seen.add(value)
  }
  return [...duplicates]
}

function hasUnsupportedTopLevelKeySyntax(lines) {
  for (let index = 0; index < lines.length; index += 1) {
    const code = stripYamlComment(lines[index])
    if (!code.trim()) continue
    const indent = indentationOf(code)
    if (indent !== 0) continue
    const trimmed = code.trimStart()
    if (isUnsupportedYamlKeyStart(trimmed) || hasYamlTagPrefix(trimmed)) return true
    const parsedKey = parseYamlMappingKey(code)
    if (parsedKey?.unsupported || /^[&*]/.test(parsedKey?.value.trim() ?? '')) return true
  }
  return false
}

function hasUnsupportedDirectChildKeySyntax(lines, start, end, parentIndent) {
  const childIndent = directChildIndent(lines, start, end, parentIndent)
  if (childIndent === null) return false
  for (let index = start; index < end; index += 1) {
    const code = stripYamlComment(lines[index])
    if (!code.trim()) continue
    const indent = indentationOf(code)
    if (indent <= parentIndent) break
    if (indent !== childIndent) continue
    const trimmed = code.trimStart()
    if (isUnsupportedYamlKeyStart(trimmed) || hasYamlTagPrefix(trimmed)) return true
    const parsedKey = parseYamlMappingKey(code)
    if (parsedKey?.unsupported || /^[&*]/.test(parsedKey?.value.trim() ?? '')) return true
  }
  return false
}

function isUnsupportedYamlKeyStart(trimmed) {
  return /^(?:<<(?=\s*:)|\?(?:\s|$)|&[A-Za-z0-9_-]+\b|\*[A-Za-z0-9_-]+\b)/.test(trimmed)
}

function hasYamlTagPrefix(trimmed) {
  return /^!(?:![^\s]+|<[^>\n]+>|[A-Za-z0-9_-]+)(?:\s+|$)/.test(trimmed)
}

function parseYamlMappingKey(line) {
  let text = String(line).trimStart()
  if (!text || text.startsWith('- ')) return null
  const tagResult = stripYamlTagPrefixes(text)
  if (tagResult.unsupported) return { unsupported: true, key: '', value: '' }
  text = tagResult.text
  const parsed = text[0] === '"' || text[0] === "'"
    ? parseQuotedYamlKey(text)
    : parsePlainYamlKey(text)
  return parsed
}

function stripYamlTagPrefixes(text) {
  let current = text
  while (current.startsWith('!')) {
    const match = current.match(/^!(?:![^\s]+|<[^>\n]+>|[A-Za-z0-9_-]+)(?:\s+|$)/)
    if (!match) return { unsupported: true, text: current }
    current = current.slice(match[0].length).trimStart()
    if (!current) return { unsupported: true, text: current }
  }
  return { unsupported: false, text: current }
}

function parsePlainYamlKey(text) {
  const match = text.match(/^([A-Za-z_][A-Za-z0-9_-]*)\s*:(.*)$/)
  if (!match) return null
  if (match[1] === '<<') return null
  return { key: match[1], value: match[2] ?? '' }
}

function parseQuotedYamlKey(text) {
  const quote = text[0]
  let key = ''
  for (let index = 1; index < text.length; index += 1) {
    const char = text[index]
    if (quote === '"' && char === '\\') {
      const decoded = decodeYamlDoubleQuotedEscape(text, index)
      if (!decoded) return { unsupported: true, key: '', value: '' }
      key += decoded.value
      index = decoded.end
      continue
    }
    if (quote === "'" && char === "'" && text[index + 1] === "'") {
      key += "'"
      index += 1
      continue
    }
    if (char === quote) {
      const rest = text.slice(index + 1)
      const match = rest.match(/^\s*:(.*)$/)
      return match ? { key, value: match[1] ?? '' } : null
    }
    if (char === '\n' || char === '\r') return { unsupported: true, key: '', value: '' }
    key += char
  }
  return { unsupported: true, key: '', value: '' }
}

function decodeYamlDoubleQuotedEscape(text, slashIndex) {
  const marker = text[slashIndex + 1]
  if (!marker) return null
  const simpleEscapes = {
    0: '\0',
    a: '\x07',
    b: '\b',
    t: '\t',
    n: '\n',
    v: '\v',
    f: '\f',
    r: '\r',
    e: '\x1b',
    '"': '"',
    '/': '/',
    '\\': '\\',
    ' ': ' ',
    '_': '\u00a0',
    N: '\u0085',
    L: '\u2028',
    P: '\u2029',
  }
  if (Object.hasOwn(simpleEscapes, marker)) return { value: simpleEscapes[marker], end: slashIndex + 1 }
  const widths = { x: 2, u: 4, U: 8 }
  const width = widths[marker]
  if (!width) return null
  const raw = text.slice(slashIndex + 2, slashIndex + 2 + width)
  if (raw.length !== width || !/^[0-9a-f]+$/i.test(raw)) return null
  const codePoint = Number.parseInt(raw, 16)
  if (codePoint > 0x10ffff) return null
  return { value: String.fromCodePoint(codePoint), end: slashIndex + 1 + width }
}

function parseSteps(lines, start, end, stepsIndent) {
  const steps = []
  for (let index = start; index < end; index += 1) {
    const code = stripYamlComment(lines[index])
    if (!code.trim()) continue
    const indent = indentationOf(code)
    if (indent <= stepsIndent) break
    if (!/^\s*-\s+/.test(code)) continue
    const stepEnd = findStepEnd(lines, index + 1, end, indent)
    steps.push(parseStep(lines.slice(index, stepEnd)))
    index = stepEnd - 1
  }
  return steps
}

function parseStep(lines) {
  const step = {
    name: '',
    runCommands: [],
    uses: '',
    if: '',
    continueOnError: '',
    shell: '',
    with: {},
    env: {},
    keys: [],
    withKeys: [],
    envKeys: [],
    duplicateErrors: [],
  }
  let withIndent = null
  let envIndent = null
  const seenStepKeys = new Set()
  const seenWithKeys = new Set()
  const seenEnvKeys = new Set()
  for (let relativeIndex = 0; relativeIndex < lines.length; relativeIndex += 1) {
    const line = stripYamlComment(lines[relativeIndex])
    if (!line.trim()) continue
    const keyLine = relativeIndex === 0 ? line.replace(/^(\s*)-\s+/, '$1') : line
    const indent = indentationOf(keyLine)
    const trimmed = keyLine.trimStart()
    const unsupportedLocalKey = isUnsupportedYamlKeyStart(trimmed) || hasYamlTagPrefix(trimmed)
    const parsedKey = parseYamlMappingKey(keyLine)
    if (withIndent !== null && indent <= withIndent) withIndent = null
    if (envIndent !== null && indent <= envIndent) envIndent = null
    if (envIndent !== null && indent > envIndent) {
      if (unsupportedLocalKey || parsedKey?.unsupported || /^[&*]/.test(parsedKey?.value.trim() ?? '')) {
        step.duplicateErrors.push('env:unsupported-key-syntax')
        continue
      }
      if (!parsedKey) continue
      const { key } = parsedKey
      const value = unquoteYamlScalar(parsedKey.value.trim())
      if (seenEnvKeys.has(key)) step.duplicateErrors.push(`env:${key}`)
      seenEnvKeys.add(key)
      step.envKeys.push(key)
      step.env[key] = value
      continue
    }
    if (withIndent !== null && indent > withIndent) {
      if (unsupportedLocalKey || parsedKey?.unsupported || /^[&*]/.test(parsedKey?.value.trim() ?? '')) {
        step.duplicateErrors.push('with:unsupported-key-syntax')
        continue
      }
      if (!parsedKey) continue
      const { key } = parsedKey
      const value = unquoteYamlScalar(parsedKey.value.trim())
      if (seenWithKeys.has(key)) step.duplicateErrors.push(`with:${key}`)
      seenWithKeys.add(key)
      step.withKeys.push(key)
      step.with[key] = value
      continue
    }
    if (unsupportedLocalKey || parsedKey?.unsupported || /^[&*]/.test(parsedKey?.value.trim() ?? '')) {
      step.duplicateErrors.push('step:unsupported-key-syntax')
      continue
    }
    if (!parsedKey) continue
    const { key } = parsedKey
    const value = unquoteYamlScalar(parsedKey.value.trim())
    if (seenStepKeys.has(key)) step.duplicateErrors.push(`step:${key}`)
    seenStepKeys.add(key)
    step.keys.push(key)
    if (key === 'with') {
      withIndent = indent
      seenWithKeys.clear()
      continue
    }
    if (key === 'env') {
      envIndent = indent
      seenEnvKeys.clear()
      continue
    }
    if (key === 'name') step.name = value
    if (key === 'uses') step.uses = value
    if (key === 'if') step.if = value
    if (key === 'continue-on-error') step.continueOnError = parsedKey.value.trim()
    if (key === 'shell') step.shell = value
    if (key === 'run') {
      if (isYamlBlockScalarHeader(value)) {
        step.runCommands.push(collectBlockScalarCommand(lines, relativeIndex + 1, indent, value))
        relativeIndex = findBlockScalarEnd(lines, relativeIndex + 1, indent) - 1
      } else {
        step.runCommands.push(value)
      }
    }
  }
  return step
}

function isYamlBlockScalarHeader(value) {
  return /^[|>](?:[+-]?[1-9]?|[1-9]?[+-]?)$/.test(value.trim())
}

function collectBlockScalarCommand(lines, start, parentIndent, header) {
  const values = []
  const end = findBlockScalarEnd(lines, start, parentIndent)
  for (let index = start; index < end; index += 1) {
    const code = stripYamlComment(lines[index])
    if (!code.trim()) continue
    values.push(code.trim())
  }
  return header.trim().startsWith('>')
    ? values.join(' ').replace(/\s+/g, ' ').trim()
    : values.join('\n').trim()
}

function findBlockScalarEnd(lines, start, parentIndent) {
  for (let index = start; index < lines.length; index += 1) {
    const code = stripYamlComment(lines[index])
    if (!code.trim()) continue
    if (indentationOf(code) <= parentIndent) return index
  }
  return lines.length
}

function stepRunsExactCommand(step, command) {
  return step.runCommands.length === 1 &&
    step.runCommands[0] === command &&
    hasDefaultStepExecutionControls(step)
}

function stepRunsSemanticReleaseVersion(step) {
  return isPythonSemanticReleaseAction(step.uses) ||
    step.runCommands.some((value) => commandRunsSemanticRelease(value))
}

function isPythonSemanticReleaseAction(value) {
  return /^python-semantic-release\/python-semantic-release@/i.test(String(value).trim())
}

function isCanonicalPythonSemanticReleaseAction(value) {
  return String(value).trim() === 'python-semantic-release/python-semantic-release@v10.4.1'
}

function isSemanticReleaseAction(value) {
  return /semantic[-_]release/i.test(String(value).trim())
}

function hasDefaultStepExecutionControls(step) {
  return (!step.if || step.if === 'success()') &&
    isAbsentOrCanonicalFalse(step.continueOnError) &&
    !step.shell
}

function isAbsentOrCanonicalFalse(value) {
  const normalized = String(value).trim()
  return normalized === '' || normalized === 'false'
}

function normalizeShellCommandForSearch(value) {
  return String(value).replace(/\\\s+/g, ' ').replace(/\s+/g, ' ').trim()
}

function commandRunsSemanticRelease(value) {
  const tokens = shellCommandTokens(value)
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]
    let cursor = index
    if (token === 'uv' && tokens[index + 1] === 'run') cursor = index + 2
    if ((tokens[cursor] === 'python' || tokens[cursor] === 'python3') && tokens[cursor + 1] === '-m' && tokens[cursor + 2] === 'semantic_release') {
      if (tokens.slice(cursor + 3).includes('version')) return true
    }
    if ((tokens[cursor] === 'semantic-release' || tokens[cursor] === 'semantic_release') && tokens.slice(cursor + 1).includes('version')) {
      return true
    }
  }
  return false
}

function commandRunsSemanticReleasePublish(value) {
  const tokens = shellCommandTokens(value)
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]
    let cursor = index
    if (token === 'uv' && tokens[index + 1] === 'run') cursor = index + 2
    if ((tokens[cursor] === 'semantic-release' || tokens[cursor] === 'semantic_release') && tokens.slice(cursor + 1).includes('publish')) {
      return true
    }
  }
  return false
}

function shellCommandTokens(value) {
  return normalizeShellCommandForSearch(value)
    .replace(/[()"'`;|&]/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
}

function isTrustReportUploadStep(step) {
  return step.uses === 'actions/upload-artifact@v4' &&
    step.if === 'always()' &&
    isAbsentOrCanonicalFalse(step.continueOnError) &&
    step.with.name === expectedTrustReportArtifactName &&
    step.with.path === expectedTrustReportPath &&
    step.with['if-no-files-found'] === 'error'
}

function isTrustReportUploadCandidate(step) {
  return step.with.name === expectedTrustReportArtifactName ||
    step.with.path === expectedTrustReportPath
}

function isCanonicalTrustGateStep(step) {
  return isExactRunStep(step, expectedWorkflowCommand, { name: 'Release trust policy' })
}

function hasCanonicalPregateSetupSequence(steps) {
  return steps.length === 5 &&
    isExactUsesStep(steps[0], 'actions/checkout@v4', { 'fetch-depth': '0' }, { name: '' }) &&
    isExactUsesStep(steps[1], 'actions/setup-python@v5', { 'python-version': '3.11.11' }, { name: 'Set up Python' }) &&
    isExactUsesStep(steps[2], 'astral-sh/setup-uv@v5', {}, { name: 'Install uv' }) &&
    isExactUsesStep(steps[3], 'pnpm/action-setup@v4', {}, { name: 'Set up pnpm' }) &&
    isExactUsesStep(steps[4], 'actions/setup-node@v4', { 'node-version': '24', cache: 'pnpm' }, { name: 'Set up Node' })
}

function hasCanonicalCreateReleaseSteps(steps) {
  return steps.length === 3 &&
    isExactUsesStep(steps[0], 'actions/checkout@v4', {
      'fetch-depth': '0',
      token: '${{ secrets.PAT_RELEASE || github.token }}',
    }, { name: '' }) &&
    isExactRunStep(steps[1], [
      'git config --global user.name "github-actions[bot]"',
      'git config --global user.email "github-actions[bot]@users.noreply.github.com"',
    ].join('\n'), { name: 'Configure Git' }) &&
    isExactUsesStep(steps[2], 'python-semantic-release/python-semantic-release@v10.4.1', {
      github_token: '${{ secrets.PAT_RELEASE || github.token }}',
      git_committer_name: 'github-actions[bot]',
      git_committer_email: 'github-actions[bot]@users.noreply.github.com',
      root_options: '-vv --strict',
      force: "${{ inputs.release_type != 'auto' && inputs.release_type || '' }}",
      prerelease: '${{ inputs.prerelease == true }}',
      prerelease_token: 'rc',
    }, {
      name: 'Python Semantic Release',
      env: { GH_TOKEN: '${{ secrets.PAT_RELEASE || github.token }}' },
    })
}

function hasCanonicalCreateReleaseJobShape(lines, createRelease, keys) {
  const expectedKeys = ['name', 'runs-on', 'needs', 'if', 'timeout-minutes', 'permissions', 'steps']
  if (hasUnsupportedDirectChildKeySyntax(lines, createRelease.start + 1, createRelease.end, createRelease.indent) ||
    !exactKeySet(keys.map((block) => block.key), expectedKeys)) {
    return false
  }

  const valueFor = (key) => unquoteYamlScalar(keys.find((block) => block.key === key)?.value.trim() ?? '')
  if (valueFor('name') !== 'Create semantic release' ||
    valueFor('runs-on') !== 'ubuntu-latest' ||
    valueFor('timeout-minutes') !== '20') {
    return false
  }

  const permissions = keys.find((block) => block.key === 'permissions')
  if (!permissions || hasUnsupportedDirectChildKeySyntax(
    lines,
    permissions.start + 1,
    permissions.end,
    permissions.indent,
  )) {
    return false
  }
  const permissionKeys = findDirectChildKeyBlocks(
    lines,
    permissions.start + 1,
    permissions.end,
    permissions.indent,
  )
  return exactKeySet(permissionKeys.map((block) => block.key), ['contents', 'id-token']) &&
    unquoteYamlScalar(permissionKeys.find((block) => block.key === 'contents')?.value.trim() ?? '') === 'write' &&
    unquoteYamlScalar(permissionKeys.find((block) => block.key === 'id-token')?.value.trim() ?? '') === 'write'
}

function hasCanonicalReleaseReadinessJobShape(lines, readiness, keys) {
  const expectedKeys = ['name', 'runs-on', 'timeout-minutes', 'steps']
  if (hasUnsupportedDirectChildKeySyntax(lines, readiness.start + 1, readiness.end, readiness.indent) ||
    !exactKeySet(keys.map((block) => block.key), expectedKeys)) {
    return false
  }
  const valueFor = (key) => unquoteYamlScalar(keys.find((block) => block.key === key)?.value.trim() ?? '')
  return valueFor('name') === 'Release readiness checks' &&
    valueFor('runs-on') === 'ubuntu-latest' &&
    valueFor('timeout-minutes') === '45'
}

function hasCanonicalWorkflowPermissions(lines, permissionBlocks) {
  if (permissionBlocks.length !== 1) return false
  const permissions = permissionBlocks[0]
  if (permissions.value !== '' || hasUnsupportedDirectChildKeySyntax(
    lines,
    permissions.start + 1,
    permissions.end,
    permissions.indent,
  )) {
    return false
  }
  const permissionKeys = findDirectChildKeyBlocks(
    lines,
    permissions.start + 1,
    permissions.end,
    permissions.indent,
  )
  return exactKeySet(permissionKeys.map((block) => block.key), ['contents']) &&
    unquoteYamlScalar(permissionKeys[0]?.value.trim() ?? '') === 'read'
}

function isExactUsesStep(step, uses, withValues, options = {}) {
  const expectedKeys = []
  if (options.name) expectedKeys.push('name')
  expectedKeys.push('uses')
  if (options.env) expectedKeys.push('env')
  if (Object.keys(withValues).length) expectedKeys.push('with')
  return step.uses === uses &&
    step.name === (options.name ?? '') &&
    step.runCommands.length === 0 &&
    step.duplicateErrors.length === 0 &&
    exactKeySet(step.keys, expectedKeys) &&
    exactObject(step.with, withValues) &&
    exactKeySet(step.withKeys, Object.keys(withValues)) &&
    exactObject(step.env, options.env ?? {}) &&
    exactKeySet(step.envKeys, Object.keys(options.env ?? {})) &&
    hasDefaultStepExecutionControls(step)
}

function isExactRunStep(step, command, options = {}) {
  return step.runCommands.length === 1 &&
    step.runCommands[0] === command &&
    step.name === (options.name ?? '') &&
    !step.uses &&
    step.duplicateErrors.length === 0 &&
    exactKeySet(step.keys, options.name ? ['name', 'run'] : ['run']) &&
    exactObject(step.with, {}) &&
    exactKeySet(step.withKeys, []) &&
    exactObject(step.env, {}) &&
    exactKeySet(step.envKeys, []) &&
    hasDefaultStepExecutionControls(step)
}

function exactObject(actual, expected) {
  const keys = Object.keys(expected)
  return exactKeySet(Object.keys(actual), keys) &&
    keys.every((key) => actual[key] === expected[key])
}

function exactKeySet(actual, expected) {
  return actual.length === expected.length && expected.every((key) => actual.includes(key))
}

function stepMutatesTrustReport(step) {
  return step.runCommands.some((command) => command.includes(expectedTrustReportPath))
}

function findBlockEnd(lines, start, end, blockIndent) {
  for (let index = start; index < end; index += 1) {
    const code = stripYamlComment(lines[index])
    if (!code.trim()) continue
    if (indentationOf(code) <= blockIndent) return index
  }
  return end
}

function findStepEnd(lines, start, end, stepIndent) {
  for (let index = start; index < end; index += 1) {
    const code = stripYamlComment(lines[index])
    if (!code.trim()) continue
    const indent = indentationOf(code)
    if (indent < stepIndent) return index
    if (indent === stepIndent && /^\s*-\s+/.test(code)) return index
  }
  return end
}

function stripYamlComment(line) {
  let quote = null
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index]
    if ((char === '"' || char === "'") && line[index - 1] !== '\\') {
      quote = quote === char ? null : quote ?? char
    }
    if (char === '#' && quote === null && (index === 0 || /\s/.test(line[index - 1]))) {
      return line.slice(0, index)
    }
  }
  return line
}

function unquoteYamlScalar(value) {
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1)
  }
  return value
}

function indentationOf(value) {
  return String(value).match(/^\s*/)[0].length
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function containsSensitiveValue(value) {
  const serialized = JSON.stringify(value)
  const matches = []
  for (const pattern of [
    /-----BEGIN [^-]+-----/,
    /\b(?:sk|pk|ghp|gho|github_pat|AKIA)[A-Za-z0-9_:-]{12,}\b/,
    /\b[A-Za-z0-9+/]{100,}={0,2}\b/,
  ]) {
    if (pattern.test(serialized)) matches.push(String(pattern))
  }
  return matches
}
