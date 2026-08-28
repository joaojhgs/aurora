#!/usr/bin/env node
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import {
  closeSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  renameSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { isIP } from 'node:net'
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const repoRoot = resolve(packageRoot, '..', '..')
const srcTauriRoot = join(packageRoot, 'src-tauri')
const args = process.argv.slice(2)
const unsignedSourceGate = args.includes('--unsigned-source-gate')

const reportPath = resolve(
  readOption('--report') ??
    join(packageRoot, 'reports', 'release-trust-policy.json'),
)
const expectedWorkflowCommand =
  readOption('--expected-workflow-command') ??
  'pnpm --dir apps/aurora-tauri run verify:static-release-trust-policy'
const expectedPackageScriptName = 'verify:static-release-trust-policy'
const expectedPackageScriptCommand = 'node scripts/assert-release-trust-policy.mjs --unsigned-source-gate'
const expectedDependencyInventoryPackageScriptName = 'verify:release-dependency-inventory'
const expectedDependencyInventoryPackageScriptCommand = 'node ../../scripts/generate_release_dependency_inventory.mjs'
const expectedDependencyInventoryWorkflowCommand =
  'pnpm --dir apps/aurora-tauri run verify:release-dependency-inventory'
const expectedDependencyInventoryArtifactName = 'release-dependency-inventory'
const expectedDependencyInventoryReportPath = 'apps/aurora-tauri/reports/release-dependency-inventory.json'
const expectedTrustReportArtifactName = 'release-trust-policy'
const expectedTrustReportPath = 'apps/aurora-tauri/reports/release-trust-policy.json'
const releaseActionRefs = Object.freeze({
  checkout: 'actions/checkout@11d5960a326750d5838078e36cf38b85af677262',
  setupPython: 'actions/setup-python@a26af69be951a213d495a4c3e4e4022e16d87065',
  setupUv: 'astral-sh/setup-uv@d4b2f3b6ecc6e67c4457f6d3e41ec42d3d0fcb86',
  setupPnpm: 'pnpm/action-setup@b906affcce14559ad1aafd4ab0e942779e9f58b1',
  setupNode: 'actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020',
  rustToolchain: 'dtolnay/rust-toolchain@2eae45db285e407f22119950686d47e1101e071b',
  installAction: 'taiki-e/install-action@37f7c5781271959fb65b6b35224e28652ff2b63d',
  uploadArtifact: 'actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02',
  semanticRelease: 'python-semantic-release/python-semantic-release@4d4cb0ab842247caea1963132c242c62aab1e4d5',
})
const sourceCommit = resolveReleaseSourceCommit(readOption('--source-commit') ?? 'HEAD')
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
  dependencyInventoryReport: resolve(
    readOption('--dependency-inventory-report') ??
      join(packageRoot, 'reports', 'release-dependency-inventory.json'),
  ),
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
const unsupportedChecks = []
const checkedRefs = []

unsupportedChecks.unshift(
  validateReleaseArtifacts({
    id: 'android-artifact-hash',
    label: 'Android',
    artifactClass: 'android-mobile-release',
    paths: readRawListOption('--android-artifact'),
    expectedSha256: readRawListOption('--android-artifact-sha256'),
    allowedExtensions: ['.apk', '.aab'],
  }),
  validateReleaseArtifacts({
    id: 'ios-artifact-hash',
    label: 'iOS',
    artifactClass: 'ios-mobile-release',
    paths: readRawListOption('--ios-artifact'),
    expectedSha256: readRawListOption('--ios-artifact-sha256'),
    allowedExtensions: ['.ipa'],
  }),
)
unsupportedChecks.push(validateDependencyInventory())

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
  for (const unsupported of unsupportedChecks.filter((item) => item.releaseBlocking && item.status !== 'passed')) {
    console.error(`- ${unsupported.id}: ${unsupported.detail}`)
  }
  process.exit(1)
}

console.log(`Release trust static policy passed. Report: ${safeDisplayPath(reportPath)}`)

function validateUpdaterPolicy(value) {
  const updater = value.plugins?.updater
  const bundle = value.bundle ?? {}
  if (unsignedSourceGate) {
    check(
      'bundle-updater-artifacts-disabled-for-unsigned-release',
      bundle.createUpdaterArtifacts === false,
      'Unsigned releases must not create updater artifacts that imply a signed update channel.',
    )
    return
  }
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
      `${safeId(basename(path))}-desktop-updater-capability`,
      capabilities.includes('aurora-desktop-updater'),
      'Desktop overlays must include aurora-desktop-updater.',
    )
    check(
      `${safeId(basename(path))}-desktop-updater-permission`,
      permissions.has('updater:default'),
      'Desktop overlays must resolve updater:default permission.',
    )
  }
  if (policy.forbidsUpdaterCapability) {
    check(
      `${safeId(basename(path))}-mobile-no-updater-capability`,
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

function validateReleaseArtifacts({ id, label, artifactClass, paths, expectedSha256, allowedExtensions }) {
  const artifactPaths = normalizedNonEmptyList(paths)
  const expectedHashes = normalizedNonEmptyList(expectedSha256).map((value) => value.toLowerCase())
  const evidence = []
  const failures = []

  if (!artifactPaths.length) {
    return {
      id,
      status: 'unsupported',
      releaseBlocking: !unsignedSourceGate,
      detail: unsignedSourceGate
        ? `${label} package bytes are validated by the canonical post-build release manifest gate.`
        : `${label} release artifact byte-hash evidence is absent from this static policy gate run.`,
      artifacts: [],
    }
  }

  if (artifactPaths.length !== paths.length) failures.push(`${label} release artifact inputs must not contain empty values.`)
  if (expectedHashes.length !== expectedSha256.length) {
    failures.push(`${label} expected SHA-256 inputs must not contain empty values.`)
  }
  if (artifactPaths.length !== new Set(artifactPaths.map((value) => resolve(value))).size) {
    failures.push(`${label} release artifact inputs must not contain duplicates.`)
  }
  if (expectedHashes.length && expectedHashes.length !== artifactPaths.length) {
    failures.push(`${label} expected SHA-256 inputs must be absent or match the artifact input count.`)
  }
  if (expectedHashes.length !== new Set(expectedHashes).size) {
    failures.push(`${label} expected SHA-256 inputs must not contain duplicates.`)
  }
  if (sourceCommit.failure) {
    failures.push(`${label} release artifact evidence must record the current release HEAD commit. ${sourceCommit.failure}`)
  }

  artifactPaths
    .map((path, index) => inspectReleaseArtifact({
      path,
      expectedSha256: expectedHashes[index] ?? null,
      artifactClass,
      allowedExtensions,
      label,
    }))
    .sort(compareArtifactEvidence)
    .forEach((result) => {
      if (result.failure) failures.push(result.failure)
      if (result.evidence) evidence.push(result.evidence)
    })

  const duplicateHashes = duplicateValues(evidence.map((item) => item.sha256))
  if (duplicateHashes.length) {
    failures.push(`${label} release artifact inputs must not duplicate artifact bytes.`)
  }

  const passed = failures.length === 0 && evidence.length === artifactPaths.length
  if (!passed) {
    blockers.push({
      id,
      detail: failures.join(' '),
      severity: 'release-blocking',
    })
  }

  return {
    id,
    status: passed ? 'passed' : 'blocked',
    releaseBlocking: true,
    detail: passed
      ? `${label} release artifact byte hashes were computed from supplied artifact inputs.`
      : failures.join(' '),
    artifacts: evidence,
  }
}

function validateDependencyInventory() {
  const id = 'sbom-license-tooling'
  const failures = []
  let raw = ''
  let report = null
  let fileStat = null
  let dispositionEvidence = { allowed: 0, reviewRequired: 0, blocked: 0 }

  try {
    fileStat = lstatSync(paths.dependencyInventoryReport)
  } catch {
    failures.push('Release dependency inventory report must exist.')
  }
  if (fileStat?.isSymbolicLink()) {
    failures.push('Release dependency inventory report must not be a symbolic link.')
  } else if (fileStat && !fileStat.isFile()) {
    failures.push('Release dependency inventory report must be a regular file.')
  } else if (fileStat?.size === 0) {
    failures.push('Release dependency inventory report must not be empty.')
  } else if (fileStat && fileStat.size > 50 * 1024 * 1024) {
    failures.push('Release dependency inventory report must not exceed 50 MiB.')
  }

  if (failures.length === 0) {
    try {
      raw = readFileSync(paths.dependencyInventoryReport, 'utf8')
      report = JSON.parse(raw)
      checkedRefs.push(checkedRef(id, paths.dependencyInventoryReport, raw))
    } catch {
      failures.push('Release dependency inventory report must be readable JSON.')
    }
  }

  const inventory = Array.isArray(report?.inventory) ? report.inventory : []
  const reportBlockers = Array.isArray(report?.blockers) ? report.blockers : []
  const reportReviewFindings = Array.isArray(report?.reviewFindings) ? report.reviewFindings : []
  const reportInputs = Array.isArray(report?.inputs) ? report.inputs : []
  const reportTools = Array.isArray(report?.tools) ? report.tools : []
  const requiredEcosystems = ['cargo', 'npm', 'phase4-native-voice', 'python']
  const requiredTools = ['cargo', 'pnpm', 'uv']
  const proofFields = [
    'legalApproval',
    'binaryCompleteness',
    'signingProof',
    'storeProof',
    'runtimeProof',
    'modelQualityProof',
    'physicalDeviceProof',
  ]

  if (report) {
    if (report.schema !== 'aurora.release-dependency-inventory.v1') {
      failures.push('Release dependency inventory schema must be version 1.')
    }
    if (sourceCommit.failure || report.source?.commit !== sourceCommit.sha) {
      failures.push('Release dependency inventory must be bound to the current release HEAD commit.')
    }
    if (report.source?.repository !== 'aurora' || report.source?.dirtyTreeIncluded !== false) {
      failures.push('Release dependency inventory source metadata must identify a clean committed Aurora source tree.')
    }
    if (report.claimBoundary?.kind !== 'static-metadata-only' ||
      proofFields.some((field) => report.claimBoundary?.[field] !== false)) {
      failures.push('Release dependency inventory must remain bounded to static metadata with every proof claim false.')
    }
    if (report.secretsRedacted !== true) {
      failures.push('Release dependency inventory must confirm redacted output.')
    }
    if (!Array.isArray(report.reviewFindings) || reportReviewFindings.some((item) =>
      !item ||
      typeof item.id !== 'string' ||
      typeof item.detail !== 'string' ||
      item.severity !== 'review-required')) {
      failures.push('Release dependency inventory review findings must be a bounded structured array.')
    }
    if (inventory.length === 0) {
      failures.push('Release dependency inventory must contain at least one entry.')
    }
    if (reportInputs.length === 0 || reportInputs.some((item) =>
      !item || typeof item.path !== 'string' || !/^[a-f0-9]{64}$/u.test(String(item.sha256)))) {
      failures.push('Release dependency inventory inputs must carry redacted references and SHA-256 evidence.')
    }
    if (reportTools.length !== requiredTools.length ||
      reportTools.some((item) =>
        !item || typeof item.name !== 'string' || typeof item.available !== 'boolean') ||
      !exactKeySet(reportTools.map((item) => item.name), requiredTools)) {
      failures.push('Release dependency inventory must record exactly the canonical static tooling set.')
    }

    const inventoryIds = inventory.map((item) => String(item?.id ?? ''))
    if (inventoryIds.some((value) => !value) || duplicateValues(inventoryIds).length > 0) {
      failures.push('Release dependency inventory entry identifiers must be non-empty and unique.')
    }
    if (inventory.some((item) =>
      !item ||
      typeof item.ecosystem !== 'string' ||
      typeof item.name !== 'string' ||
      typeof item.version !== 'string' ||
      typeof item.sourceRef !== 'string' ||
      !/^(?:sha256:[a-f0-9]{64}|sha512:[a-f0-9]{128})$/u.test(String(item.hash)) ||
      !['allowed', 'review-required', 'blocked'].includes(item.disposition) ||
      typeof item.license?.id !== 'string' ||
      item.license.id.length === 0 ||
      item.license.id.length > 256 ||
      typeof item.license?.evidence !== 'string' ||
      !/^sha256:[a-f0-9]{64}$/u.test(String(item.license?.evidenceHash)))) {
      failures.push('Release dependency inventory entries must contain bounded license evidence and SHA-256 or SHA-512 integrity metadata.')
    }

    const expectedEcosystems = countInventoryValues(inventory, 'ecosystem')
    const expectedDispositions = countInventoryValues(inventory, 'disposition')
    dispositionEvidence = {
      allowed: expectedDispositions.allowed ?? 0,
      reviewRequired: expectedDispositions['review-required'] ?? 0,
      blocked: expectedDispositions.blocked ?? 0,
    }
    if (report.summary?.totalEntries !== inventory.length ||
      !sameCountMap(report.summary?.ecosystems, expectedEcosystems) ||
      !sameCountMap(report.summary?.dispositions, expectedDispositions)) {
      failures.push('Release dependency inventory summary must match its entries exactly.')
    }
    if (!exactKeySet(Object.keys(expectedEcosystems), requiredEcosystems)) {
      failures.push('Release dependency inventory must cover npm, Python, Cargo, and Phase 4 native voice artifacts.')
    }
    if (inventory.some((item) => ['UNKNOWN', 'UNREVIEWED'].includes(item.license?.id) && item.disposition !== 'review-required')) {
      failures.push('Unknown or unreviewed licenses must remain explicitly marked review-required.')
    }
    if (inventory.some((item) => item.disposition === 'review-required') && reportReviewFindings.length === 0) {
      failures.push('Review-required inventory entries must have structured review findings.')
    }
    const serializedInventory = JSON.stringify(report)
    if (/(?:ghp_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9_-]{20,}|xoxb-[A-Za-z0-9-]{20,}|AKIA[A-Z0-9]{16})/u.test(serializedInventory) ||
      /(?:\/(?:home|Users)\/[^"\\]+|[A-Za-z]:\\Users\\[^"\\]+)/u.test(serializedInventory)) {
      failures.push('Release dependency inventory must not contain token-shaped secrets or absolute user paths.')
    }

    const claimsPassed = report.status === 'passed' && report.releaseBlocked === false
    const claimsBlocked = report.status === 'blocked' && report.releaseBlocked === true
    if (!claimsPassed && !claimsBlocked) {
      failures.push('Release dependency inventory status and releaseBlocked fields must be consistent.')
    }
    if (claimsPassed && (reportBlockers.length > 0 ||
      inventory.some((item) => item.disposition === 'blocked') ||
      reportTools.some((item) => item.available !== true))) {
      failures.push('A passing release dependency inventory must have no blockers, unavailable tools, or blocked integrity/source entries.')
    }
    if (claimsBlocked && reportBlockers.length === 0) {
      failures.push('A blocked release dependency inventory must explain at least one blocker.')
    }
  }

  const passed = failures.length === 0 && report?.status === 'passed' && report.releaseBlocked === false
  const reportSha256 = raw ? createHash('sha256').update(raw).digest('hex') : null
  return {
    id,
    status: passed ? 'passed' : 'blocked',
    releaseBlocking: true,
    detail: passed
      ? 'Static dependency integrity and source inventory is complete; later license review remains explicit without claiming approval.'
      : failures.length > 0
        ? `${failures.join(' ')}${reportBlockers.length > 0
          ? ` Inventory also reports ${reportBlockers.length} release-blocking issue(s).`
          : ''}`
        : `Static dependency and license inventory remains release-blocking with ${reportBlockers.length} reported blocker(s).`,
    evidence: report ? {
      sourceCommit: report.source?.commit ?? null,
      reportSha256,
      totalEntries: inventory.length,
      dispositions: dispositionEvidence,
      legalApproval: false,
      runtimeProof: false,
    } : null,
  }
}

function countInventoryValues(inventory, field) {
  const counts = {}
  for (const item of inventory) {
    const value = String(item?.[field] ?? '')
    if (!value) continue
    counts[value] = (counts[value] ?? 0) + 1
  }
  return Object.fromEntries(Object.entries(counts).sort(([left], [right]) => left.localeCompare(right)))
}

function sameCountMap(actual, expected) {
  if (!actual || typeof actual !== 'object' || Array.isArray(actual)) return false
  const actualEntries = Object.entries(actual).sort(([left], [right]) => left.localeCompare(right))
  const expectedEntries = Object.entries(expected)
  return JSON.stringify(actualEntries) === JSON.stringify(expectedEntries)
}

function inspectReleaseArtifact({ path, expectedSha256, artifactClass, allowedExtensions, label }) {
  const resolved = resolve(path)
  const extension = extname(resolved).toLowerCase()
  if (!allowedExtensions.includes(extension)) {
    return { failure: `${label} artifact ${safeArtifactName(path)} must use one of: ${allowedExtensions.join(', ')}.` }
  }

  const inspected = inspectRegularFile(resolved, label)
  if (inspected.failure) return { failure: inspected.failure }

  let hashed
  try {
    hashed = hashFile(resolved)
  } catch {
    return { failure: `${label} artifact ${safeArtifactName(path)} must be readable as a regular file.` }
  }

  if (hashed.sizeBytes !== inspected.sizeBytes) {
    return { failure: `${label} artifact ${safeArtifactName(path)} size changed while it was inspected.` }
  }
  if (expectedSha256 && !/^[a-f0-9]{64}$/i.test(expectedSha256)) {
    return { failure: `${label} artifact ${safeArtifactName(path)} expected SHA-256 must be 64 hex characters.` }
  }
  if (expectedSha256 && hashed.sha256 !== expectedSha256.toLowerCase()) {
    return { failure: `${label} artifact ${safeArtifactName(path)} SHA-256 does not match its expected value.` }
  }

  return {
    evidence: {
      artifactClass,
      artifactName: safeArtifactName(path),
      ref: safeDisplayPath(resolved),
      sourceCommit: sourceCommit.sha,
      sizeBytes: hashed.sizeBytes,
      sha256: hashed.sha256,
    },
  }
}

function inspectRegularFile(path, label) {
  let linkStat
  try {
    linkStat = lstatSync(path)
  } catch {
    return { failure: `${label} artifact ${safeArtifactName(path)} must exist and be readable.` }
  }
  if (linkStat.isSymbolicLink()) {
    return { failure: `${label} artifact ${safeArtifactName(path)} must not be a symbolic link.` }
  }

  let fileStat
  try {
    fileStat = statSync(path)
  } catch {
    return { failure: `${label} artifact ${safeArtifactName(path)} must be inspectable.` }
  }
  if (!fileStat.isFile()) {
    return { failure: `${label} artifact ${safeArtifactName(path)} must be a regular file.` }
  }
  if (fileStat.size <= 0) {
    return { failure: `${label} artifact ${safeArtifactName(path)} must not be empty.` }
  }
  return { sizeBytes: fileStat.size }
}

function hashFile(path) {
  const hash = createHash('sha256')
  const buffer = Buffer.allocUnsafe(1024 * 1024)
  let sizeBytes = 0
  let fd = null
  try {
    fd = openSync(path, 'r')
    while (true) {
      const bytesRead = readSync(fd, buffer, 0, buffer.length, null)
      if (bytesRead === 0) break
      sizeBytes += bytesRead
      hash.update(buffer.subarray(0, bytesRead))
    }
    return { sha256: hash.digest('hex'), sizeBytes }
  } finally {
    if (fd !== null) closeSync(fd)
  }
}

function resolveReleaseSourceCommit(value) {
  const raw = String(value).trim()
  if (!raw) return { sha: '', failure: 'Source commit input must not be empty.' }
  if (!/^(?:HEAD|[a-f0-9]{7,40})$/i.test(raw)) {
    return { sha: '', failure: 'Source commit input must be HEAD or a hex commit identifier.' }
  }
  let candidate
  let head
  try {
    execFileSync('git', ['cat-file', '-e', `${raw}^{commit}`], {
      cwd: repoRoot,
      stdio: ['ignore', 'ignore', 'ignore'],
    })
    candidate = gitRevParse(`${raw}^{commit}`)
    head = gitRevParse('HEAD^{commit}')
  } catch {
    return { sha: '', failure: 'Source commit must resolve to an existing commit.' }
  }
  if (candidate !== head) {
    return { sha: candidate, failure: 'Source commit must resolve exactly to the current release HEAD.' }
  }
  return { sha: candidate, failure: '' }
}

function gitRevParse(value) {
  return execFileSync('git', ['rev-parse', value], {
    cwd: repoRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  }).trim()
}

function normalizedNonEmptyList(values) {
  return values.map((item) => String(item).trim()).filter(Boolean)
}

function duplicateValues(values) {
  const seen = new Set()
  const duplicates = new Set()
  for (const value of values) {
    if (seen.has(value)) duplicates.add(value)
    seen.add(value)
  }
  return [...duplicates]
}

function compareArtifactEvidence(left, right) {
  const leftEvidence = left.evidence ?? {}
  const rightEvidence = right.evidence ?? {}
  return String(leftEvidence.artifactClass ?? '').localeCompare(String(rightEvidence.artifactClass ?? '')) ||
    String(leftEvidence.artifactName ?? '').localeCompare(String(rightEvidence.artifactName ?? '')) ||
    String(leftEvidence.sha256 ?? '').localeCompare(String(rightEvidence.sha256 ?? '')) ||
    String(left.failure ?? '').localeCompare(String(right.failure ?? ''))
}

function safeArtifactName(path) {
  return safeId(basename(path))
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
  const dependencyInventoryCommandIndexes = steps
    .map((step, index) => isCanonicalDependencyInventoryStep(step) ? index : -1)
    .filter((index) => index >= 0)
  const dependencyInventoryUploadIndexes = steps
    .map((step, index) => isDependencyInventoryReportUploadCandidate(step) ? index : -1)
    .filter((index) => index >= 0)
  const dependencyInventoryCommandStepIndex = dependencyInventoryCommandIndexes[0] ?? -1
  const dependencyInventoryUploadStepIndex = dependencyInventoryUploadIndexes[0] ?? -1
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
    'Release workflow must run the trust gate after the exact canonical setup, dependency installation, inventory, and inventory-upload sequence.',
  )
  check(
    'workflow-dependency-inventory-report-upload-always',
    dependencyInventoryCommandIndexes.length === 1 &&
      dependencyInventoryUploadIndexes.length === 1 &&
      isDependencyInventoryReportUploadStep(steps[dependencyInventoryUploadStepIndex]) &&
      dependencyInventoryUploadStepIndex === dependencyInventoryCommandStepIndex + 1 &&
      commandStepIndex === dependencyInventoryUploadStepIndex + 1 &&
      !steps.some((step, index) =>
        index !== dependencyInventoryCommandStepIndex && stepMutatesDependencyInventoryReport(step)),
    'Release workflow must generate and always upload exactly one canonical dependency inventory immediately before the trust gate.',
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
  check(
    'package-release-dependency-inventory-script',
    packageJson.value.scripts?.[expectedDependencyInventoryPackageScriptName] ===
      expectedDependencyInventoryPackageScriptCommand,
    `Package script ${expectedDependencyInventoryPackageScriptName} must run the release dependency inventory guard.`,
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

function readRawListOption(name) {
  const values = []
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === name) values.push(...String(args[index + 1] ?? '').split(','))
  }
  return values
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
  if (isPathInside(resolved, repoRoot)) return `<repo-root>/${relative(repoRoot, resolved).replace(/\\/g, '/')}`
  if (isPathInside(resolved, packageRoot)) return `<package-root>/${relative(packageRoot, resolved).replace(/\\/g, '/')}`
  return `<external>/${safeId(basename(resolved))}`
}

function isPathInside(path, root) {
  const rel = relative(root, path)
  return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`))
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
        redactSensitiveString(key, '<redacted-key>'),
        isSensitiveKey(key) ? '<redacted>' : redactSensitiveValues(item, key),
      ]),
    )
  }
  if (typeof value === 'string') {
    if (isSensitiveKey(parentKey)) return '<redacted>'
    return redactSensitiveString(value, '<redacted>')
  }
  return value
}

function redactSensitiveString(value, replacement) {
  return String(value)
    .replace(/-----BEGIN [^-]+-----[\s\S]*?-----END [^-]+-----/g, replacement)
    .replace(/\b(?:sk|pk|ghp|gho|github_pat|AKIA)[A-Za-z0-9_:-]{12,}\b/g, replacement)
    .replace(/\b[A-Za-z0-9+/]{80,}={0,2}\b/g, replacement)
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
  const jobNames = directJobs.map((job) => job.key)
  const legacyJobSet = ['release-readiness', 'create-release']
  const canonicalProductJobSet = [
    'release-readiness',
    'build-portable-packages',
    'build-desktop-packages',
    'build-android-packages',
    'build-ios-package',
    'validate-containers',
    'create-release',
    'publish-release-assets',
    'publish-containers',
  ]
  const canonicalProductWorkflow = exactKeySet(jobNames, canonicalProductJobSet)
  if (!exactKeySet(jobNames, legacyJobSet) && !canonicalProductWorkflow) {
    return ['release-jobs:canonical-job-set']
  }
  const releaseJobs = directJobs.filter((job) => job.key === 'create-release' || jobContainsReleaseSignal(lines, job))
  const createReleaseJobs = releaseJobs.filter((job) => job.key === 'create-release')
  const errors = []
  if (releaseJobs.length !== 1 || createReleaseJobs.length !== 1) errors.push('release-jobs:canonical-create-release')
  if (createReleaseJobs.length === 1) {
    errors.push(...inspectCreateReleaseJob(lines, createReleaseJobs[0], canonicalProductWorkflow))
  }
  return errors
}

function inspectLocalJobStructure(lines, directJobs) {
  const errors = []
  const reusableBuildJobs = new Map([
    ['build-desktop-packages', './.github/workflows/tauri-desktop.yml'],
    ['build-android-packages', './.github/workflows/tauri-android.yml'],
    ['build-ios-package', './.github/workflows/tauri-ios.yml'],
    ['validate-containers', './.github/workflows/docker-build.yml'],
    ['publish-containers', './.github/workflows/docker-build.yml'],
  ])
  for (const job of directJobs) {
    const keys = findDirectChildKeyBlocks(lines, job.start + 1, job.end, job.indent)
    const uses = keys.filter((block) => block.key === 'uses')
    const secrets = keys.filter((block) => block.key === 'secrets')
    const expectedReusableWorkflow = reusableBuildJobs.get(job.key)
    if (expectedReusableWorkflow) {
      if (
        uses.length !== 1 ||
        unquoteYamlScalar(uses[0].value.trim()) !== expectedReusableWorkflow ||
        secrets.length > 0 ||
        keys.some((block) => block.key === 'steps' || block.key === 'runs-on')
      ) {
        errors.push(`job:${job.key}:reusable`)
      }
    } else if (uses.length > 0 || secrets.length > 0) {
      errors.push(`job:${job.key}:reusable`)
    }
    if (job.key === 'create-release') {
      if (keys.some((block) => block.key === 'strategy' || block.key === 'matrix')) errors.push('create-release:matrix')
      if (!keys.some((block) => block.key === 'steps')) errors.push('create-release:steps')
    }
  }
  return errors
}

function inspectCreateReleaseJob(lines, createRelease, canonicalProductWorkflow) {
  const errors = []
  const keys = findDirectChildKeyBlocks(lines, createRelease.start + 1, createRelease.end, createRelease.indent)
  errors.push(...duplicateKeys(keys.map((block) => block.key)).map((key) => `create-release:${key}`))
  if (!hasCanonicalCreateReleaseJobShape(lines, createRelease, keys)) {
    errors.push('create-release:job-shape')
  }
  const needs = keys.filter((block) => block.key === 'needs')
  const expectedNeeds = canonicalProductWorkflow
    ? [
        'release-readiness',
        'build-portable-packages',
        'build-desktop-packages',
        'build-android-packages',
        'build-ios-package',
        'validate-containers',
      ]
    : ['release-readiness']
  if (needs.length !== 1 || !exactKeySet(readYamlScalarSequence(lines, needs[0]), expectedNeeds)) {
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

function readYamlScalarSequence(lines, block) {
  if (block.value) return [unquoteYamlScalar(block.value.trim())]
  const values = []
  const childIndent = directChildIndent(lines, block.start + 1, block.end, block.indent)
  if (childIndent === null) return values
  for (let index = block.start + 1; index < block.end; index += 1) {
    const code = stripYamlComment(lines[index])
    if (!code.trim() || indentationOf(code) !== childIndent) continue
    const match = /^\s*-\s+([^\s].*)$/u.exec(code)
    if (!match || parseYamlMappingKey(match[1])) return []
    values.push(unquoteYamlScalar(match[1].trim()))
  }
  return values
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
    id: '',
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
    if (key === 'id') step.id = value
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
  return String(value).trim() === releaseActionRefs.semanticRelease
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
  return step.uses === releaseActionRefs.uploadArtifact &&
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
  return step.runCommands.length === 1 &&
    step.runCommands[0] === expectedWorkflowCommand &&
    step.name === 'Release trust policy' &&
    step.if === 'always()' &&
    !step.uses &&
    step.duplicateErrors.length === 0 &&
    exactKeySet(step.keys, ['name', 'if', 'run']) &&
    exactObject(step.with, {}) &&
    exactKeySet(step.withKeys, []) &&
    exactObject(step.env, {}) &&
    exactKeySet(step.envKeys, []) &&
    isAbsentOrCanonicalFalse(step.continueOnError) &&
    !step.shell
}

function isCanonicalDependencyInventoryStep(step) {
  return isExactRunStep(step, expectedDependencyInventoryWorkflowCommand, {
    name: 'Release dependency inventory',
  })
}

function isDependencyInventoryReportUploadStep(step) {
  return step.uses === releaseActionRefs.uploadArtifact &&
    step.name === 'Upload release dependency inventory report' &&
    step.if === 'always()' &&
    isAbsentOrCanonicalFalse(step.continueOnError) &&
    step.runCommands.length === 0 &&
    step.duplicateErrors.length === 0 &&
    exactKeySet(step.keys, ['name', 'if', 'uses', 'with']) &&
    exactObject(step.env, {}) &&
    exactKeySet(step.envKeys, []) &&
    exactObject(step.with, {
      name: expectedDependencyInventoryArtifactName,
      path: expectedDependencyInventoryReportPath,
      'if-no-files-found': 'error',
    }) &&
    exactKeySet(step.withKeys, ['name', 'path', 'if-no-files-found'])
}

function isDependencyInventoryReportUploadCandidate(step) {
  return step.with.name === expectedDependencyInventoryArtifactName ||
    step.with.path === expectedDependencyInventoryReportPath
}

function hasCanonicalPregateSetupSequence(steps) {
  return steps.length === 11 &&
    isExactUsesStep(steps[0], releaseActionRefs.checkout, { 'fetch-depth': '0' }, { name: '' }) &&
    isExactUsesStep(steps[1], releaseActionRefs.setupPython, { 'python-version': '3.11.11' }, { name: 'Set up Python' }) &&
    isExactUsesStep(steps[2], releaseActionRefs.setupUv, {}, { name: 'Install uv' }) &&
    isExactUsesStep(steps[3], releaseActionRefs.setupPnpm, {}, { name: 'Set up pnpm' }) &&
    isExactUsesStep(steps[4], releaseActionRefs.setupNode, { 'node-version': '24', cache: 'pnpm' }, { name: 'Set up Node' }) &&
    isExactUsesStep(steps[5], releaseActionRefs.rustToolchain, { targets: 'wasm32-unknown-unknown' }, { name: 'Set up Rust for browser voice runtime' }) &&
    isExactUsesStep(steps[6], releaseActionRefs.installAction, {
      tool: 'wasm-bindgen-cli@0.2.126',
      fallback: 'none',
    }, { name: 'Install pinned browser voice toolchain' }) &&
    isExactRunStep(steps[7], 'uv sync --extra dev --extra build', { name: 'Install Python release dependencies' }) &&
    isExactRunStep(steps[8], 'pnpm install --frozen-lockfile', { name: 'Install workspace dependencies' }) &&
    isCanonicalDependencyInventoryStep(steps[9]) &&
    isDependencyInventoryReportUploadStep(steps[10])
}

function hasCanonicalCreateReleaseSteps(steps) {
  const semanticReleaseWith = {
    github_token: '${{ secrets.PAT_RELEASE || github.token }}',
    git_committer_name: 'github-actions[bot]',
    git_committer_email: 'github-actions[bot]@users.noreply.github.com',
    verbosity: '2',
    strict: 'true',
    force: "${{ inputs.release_type != 'auto' && inputs.release_type || '' }}",
    prerelease: '${{ inputs.prerelease == true }}',
    prerelease_token: 'rc',
  }
  const semanticReleaseOptions = {
    name: 'Python Semantic Release',
    env: { GH_TOKEN: '${{ secrets.PAT_RELEASE || github.token }}' },
  }
  return steps.length === 3 &&
    isExactUsesStep(steps[0], releaseActionRefs.checkout, {
      'fetch-depth': '0',
      token: '${{ secrets.PAT_RELEASE || github.token }}',
    }, { name: '' }) &&
    isExactRunStep(steps[1], [
      'git config --global user.name "github-actions[bot]"',
      'git config --global user.email "github-actions[bot]@users.noreply.github.com"',
    ].join('\n'), { name: 'Configure Git' }) &&
    (
      isExactUsesStep(
        steps[2],
        releaseActionRefs.semanticRelease,
        semanticReleaseWith,
        semanticReleaseOptions,
      ) ||
      isExactUsesStep(
        steps[2],
        releaseActionRefs.semanticRelease,
        semanticReleaseWith,
        { ...semanticReleaseOptions, id: 'release' },
      )
    )
}

function hasCanonicalCreateReleaseJobShape(lines, createRelease, keys) {
  const requiredKeys = ['name', 'runs-on', 'needs', 'if', 'timeout-minutes', 'permissions', 'steps']
  const actualKeys = keys.map((block) => block.key)
  if (hasUnsupportedDirectChildKeySyntax(lines, createRelease.start + 1, createRelease.end, createRelease.indent) ||
    (!exactKeySet(actualKeys, requiredKeys) && !exactKeySet(actualKeys, [...requiredKeys, 'outputs']))) {
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
  const requiredKeys = ['name', 'runs-on', 'timeout-minutes', 'steps']
  const actualKeys = keys.map((block) => block.key)
  if (hasUnsupportedDirectChildKeySyntax(lines, readiness.start + 1, readiness.end, readiness.indent) ||
    (!exactKeySet(actualKeys, requiredKeys) && !exactKeySet(actualKeys, [...requiredKeys, 'outputs']))) {
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
  if (options.id) expectedKeys.push('id')
  expectedKeys.push('uses')
  if (options.env) expectedKeys.push('env')
  if (Object.keys(withValues).length) expectedKeys.push('with')
  return step.uses === uses &&
    step.name === (options.name ?? '') &&
    step.id === (options.id ?? '') &&
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

function stepMutatesDependencyInventoryReport(step) {
  return step.runCommands.some((command) => command.includes(expectedDependencyInventoryReportPath))
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
