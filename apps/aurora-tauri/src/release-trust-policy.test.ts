// @vitest-environment node

import { Buffer } from 'node:buffer'
import { createHash } from 'node:crypto'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it, vi } from 'vitest'

vi.setConfig({ testTimeout: 60_000 })

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const repoRoot = resolve(packageRoot, '..', '..')
const script = join(packageRoot, 'scripts', 'assert-release-trust-policy.mjs')
const expectedTrustCommand = 'pnpm --dir apps/aurora-tauri run verify:static-release-trust-policy'
const expectedPackageScriptName = 'verify:static-release-trust-policy'
const expectedPackageScriptCommand = 'node scripts/assert-release-trust-policy.mjs'
const expectedDependencyInventoryPackageScriptName = 'verify:release-dependency-inventory'
const expectedDependencyInventoryPackageScriptCommand = 'node ../../scripts/generate_release_dependency_inventory.mjs'
const expectedDependencyInventoryCommand = 'pnpm --dir apps/aurora-tauri run verify:release-dependency-inventory'
const expectedDependencyInventoryReportPath = 'apps/aurora-tauri/reports/release-dependency-inventory.json'
const expectedTrustReportPath = 'apps/aurora-tauri/reports/release-trust-policy.json'
const expectedSemanticReleaseCommand = 'uv run semantic-release version --print --no-commit --no-tag --no-push --no-vcs-release'
const currentSourceCommit = execFileSync('git', ['rev-parse', 'HEAD'], {
  cwd: repoRoot,
  encoding: 'utf8',
}).trim()
const minisignPublicKeyLine = 'RWQf6LRCGA9i53mlYecO4IzT51TGPpvWucNSCh1CBM0QTaLn73Y7GFO3'
const realisticTauriUpdaterPubkey = Buffer.from(
  `untrusted comment: minisign public key\n${minisignPublicKeyLine}\n`,
  'utf8',
).toString('base64')

interface Fixture {
  root: string
  packageJson: string
  config: string
  capabilities: string
  linux: string
  macos: string
  windows: string
  ios: string
  iosThin: string
  workflow: string
  androidBuild: string
  androidArtifact: string
  androidPreflight: string
  iosBuild: string
  iosEvidence: string
  iosPreflight: string
  dependencyInventoryReport: string
  report: string
}

function createFixture(): Fixture {
  const root = mkdtempSync(join(tmpdir(), 'aurora-release-trust-policy-'))
  const capabilities = join(root, 'capabilities')
  mkdirSync(capabilities, { recursive: true })
  const fixture: Fixture = {
    root,
    packageJson: join(root, 'package.json'),
    config: join(root, 'tauri.conf.json'),
    capabilities,
    linux: join(root, 'tauri.linux.conf.json'),
    macos: join(root, 'tauri.macos.conf.json'),
    windows: join(root, 'tauri.windows.conf.json'),
    ios: join(root, 'tauri.ios.conf.json'),
    iosThin: join(root, 'tauri.ios-thin.conf.json'),
    workflow: join(root, 'release.yml'),
    androidBuild: join(root, 'build-android-client-bundle.mjs'),
    androidArtifact: join(root, 'assert-android-client-artifact-clean.mjs'),
    androidPreflight: join(root, 'android-preflight.mjs'),
    iosBuild: join(root, 'build-ios-client-bundle.mjs'),
    iosEvidence: join(root, 'assert-ios-ci-evidence.mjs'),
    iosPreflight: join(root, 'ios-preflight.mjs'),
    dependencyInventoryReport: join(root, 'release-dependency-inventory.json'),
    report: join(root, 'release-trust-policy.json'),
  }
  writeJson(fixture.packageJson, { scripts: {
    [expectedPackageScriptName]: expectedPackageScriptCommand,
    [expectedDependencyInventoryPackageScriptName]: expectedDependencyInventoryPackageScriptCommand,
  } })
  writeJson(fixture.config, productionTauriConfig())
  writeJson(join(capabilities, 'aurora-desktop-updater.json'), {
    identifier: 'aurora-desktop-updater',
    permissions: ['updater:default'],
  })
  writeJson(join(capabilities, 'aurora-ios-baseline.json'), {
    identifier: 'aurora-ios-baseline',
    permissions: ['aurora-command'],
  })
  writeJson(join(capabilities, 'aurora-ios-thin.json'), {
    identifier: 'aurora-ios-thin',
    permissions: ['aurora-thin-profile', 'aurora-thin-peer-credentials'],
  })
  writeJson(fixture.linux, desktopOverlay())
  writeJson(fixture.macos, desktopOverlay())
  writeJson(fixture.windows, desktopOverlay())
  writeJson(fixture.ios, { app: { security: { capabilities: ['aurora-ios-baseline'] } } })
  writeJson(fixture.iosThin, { app: { security: { capabilities: ['aurora-ios-thin'] } } })
  writeFileSync(fixture.workflow, validWorkflow())
  writeFileSync(fixture.androidBuild, sourceWith('createHash("sha256")\nconfigSha256\nsecretsRedacted: true\nredacted(path)\nartifactSha256\n'))
  writeFileSync(fixture.androidArtifact, sourceWith('createHash("sha256")\nconfigSha256\nconst bytes = readFileSync(artifactPath)\nconst artifactSha256 = createHash("sha256").update(bytes).digest("hex")\nevidence.artifactSha256 = artifactSha256\nsecretsRedacted: true\nredacted(path)\n'))
  writeFileSync(fixture.androidPreflight, sourceWith('const strict = args.has("--strict")\nANDROID_KEYSTORE_PATH\nTAURI_ANDROID_KEYSTORE_PATH\nAURORA_ANDROID_SIGNING_CONFIGURED\nsecretsRedacted: true\nredacted(path)\n'))
  writeFileSync(fixture.iosBuild, sourceWith('createHash("sha256")\nconfigSha256\nappSha256\nsecretsRedacted: true\nredacted(path)\n'))
  writeFileSync(fixture.iosEvidence, sourceWith('const appBytes = readFileSync(appPath)\nconst appSha256 = createHash("sha256").update(appBytes).digest("hex")\nevidence.appSha256 = appSha256\nsecretsRedacted === true\nredacted(path)\n'))
  writeFileSync(fixture.iosPreflight, sourceWith('const requireSigningEnv = args.has("--require-signing-env")\nAPPLE_API_KEY_ID\nAPPLE_API_ISSUER\nAPPLE_API_KEY_PATH\nAPPLE_API_PRIVATE_KEY\nsecretsRedacted: true\n'))
  writeJson(fixture.dependencyInventoryReport, validDependencyInventoryReport())
  return fixture
}

function runPolicy(fixture: Fixture, extraArgs: string[] = []) {
  return spawnSync(process.execPath, [
    script,
    '--package-json', fixture.packageJson,
    '--config', fixture.config,
    '--capabilities-dir', fixture.capabilities,
    '--desktop-overlay', [fixture.linux, fixture.macos, fixture.windows].join(','),
    '--mobile-overlay', [fixture.ios, fixture.iosThin].join(','),
    '--workflow', fixture.workflow,
    '--android-build-script', fixture.androidBuild,
    '--android-artifact-script', fixture.androidArtifact,
    '--android-preflight-script', fixture.androidPreflight,
    '--ios-build-script', fixture.iosBuild,
    '--ios-evidence-script', fixture.iosEvidence,
    '--ios-preflight-script', fixture.iosPreflight,
    '--dependency-inventory-report', fixture.dependencyInventoryReport,
    '--report', fixture.report,
    ...extraArgs,
  ], {
    cwd: packageRoot,
    encoding: 'utf8',
  })
}

function readReport(fixture: Fixture) {
  return JSON.parse(readFileSync(fixture.report, 'utf8'))
}

function writeArtifact(path: string, content: string) {
  writeFileSync(path, content)
  return createHash('sha256').update(content).digest('hex')
}

describe('release trust static policy guard', () => {
  it('reports the current repo as statically blocked without claiming signature or store proof', () => {
    const fixture = createFixture()
    const result = spawnSync(process.execPath, [script, '--report', fixture.report], {
      cwd: packageRoot,
      encoding: 'utf8',
    })

    expect(result.status).not.toBe(0)
    const report = readReport(fixture)
    expect(report).toMatchObject({
      status: 'blocked',
      claimBoundary: 'static-policy-only',
      signatureProof: false,
      storeProof: false,
      externalEvidenceRequired: true,
      releaseBlocked: true,
      secretsRedacted: true,
    })
    expect(report.blockers.map((item: { id: string }) => item.id)).toEqual(
      expect.arrayContaining([
        'updater-public-key-plausible',
        'updater-endpoint-1-https-production',
      ]),
    )
    expect(report.unsupportedChecks).toContainEqual(
      expect.objectContaining({
        id: 'sbom-license-tooling',
        status: 'blocked',
        releaseBlocking: true,
      }),
    )
  })

  it('passes a fully policy-shaped static fixture except for release-blocking unsupported evidence', () => {
    const fixture = createFixture()
    const result = runPolicy(fixture)

    expect(result.status).not.toBe(0)
    const report = readReport(fixture)
    expect(report.claimBoundary).toBe('static-policy-only')
    expect(report.signatureProof).toBe(false)
    expect(report.storeProof).toBe(false)
    expect(report.externalEvidenceRequired).toBe(true)
    expect(report.blockers).toEqual([])
    expect(report.status).toBe('blocked')
    expect(report.releaseBlocked).toBe(true)
    expect(report.unsupportedChecks).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'android-artifact-hash', releaseBlocking: true }),
      expect.objectContaining({ id: 'ios-artifact-hash', releaseBlocking: true }),
      expect.objectContaining({ id: 'sbom-license-tooling', status: 'passed', releaseBlocking: true }),
    ]))
    expect(report.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'workflow-trust-gate-before-semver', status: 'passed' }),
        expect.objectContaining({ id: 'workflow-trust-report-upload-always', status: 'passed' }),
        expect.objectContaining({ id: 'workflow-dependency-inventory-report-upload-always', status: 'passed' }),
        expect.objectContaining({ id: 'workflow-release-readiness-unique-structure', status: 'passed' }),
        expect.objectContaining({ id: 'workflow-release-readiness-unique-step-keys', status: 'passed' }),
        expect.objectContaining({ id: 'package-static-release-trust-policy-script', status: 'passed' }),
        expect.objectContaining({ id: 'package-release-dependency-inventory-script', status: 'passed' }),
      ]),
    )
    expect(report.checkedRefs.length).toBeGreaterThan(8)
  })

  it('fails closed for missing, invalid, stale, blocked, symlinked, or internally inconsistent dependency inventory reports', () => {
    const cases: Array<[string, (fixture: Fixture) => void]> = [
      ['missing', (fixture) => rmSync(fixture.dependencyInventoryReport)],
      ['invalid JSON', (fixture) => writeFileSync(fixture.dependencyInventoryReport, '{invalid')],
      ['stale commit', (fixture) => {
        const report = validDependencyInventoryReport()
        report.source.commit = '0'.repeat(40)
        writeJson(fixture.dependencyInventoryReport, report)
      }],
      ['blocked', (fixture) => {
        const report = validDependencyInventoryReport()
        report.status = 'blocked'
        report.releaseBlocked = true
        report.inventory[0].disposition = 'blocked'
        report.summary.dispositions = { allowed: report.inventory.length - 1, blocked: 1 }
        report.blockers = [{ id: 'blocked-license-disposition', severity: 'high', detail: 'blocked fixture' }]
        writeJson(fixture.dependencyInventoryReport, report)
      }],
      ['false proof claim', (fixture) => {
        const report = validDependencyInventoryReport()
        report.claimBoundary.runtimeProof = true
        writeJson(fixture.dependencyInventoryReport, report)
      }],
      ['tampered summary', (fixture) => {
        const report = validDependencyInventoryReport()
        report.summary.totalEntries += 1
        writeJson(fixture.dependencyInventoryReport, report)
      }],
      ['missing ecosystem', (fixture) => {
        const report = validDependencyInventoryReport()
        report.inventory = report.inventory.filter((item: { ecosystem: string }) =>
          item.ecosystem !== 'phase4-native-voice')
        report.summary.totalEntries = report.inventory.length
        delete report.summary.ecosystems['phase4-native-voice']
        report.summary.dispositions.allowed = report.inventory.length
        writeJson(fixture.dependencyInventoryReport, report)
      }],
      ['secret-shaped metadata', (fixture) => {
        const report = validDependencyInventoryReport()
        report.inventory[0].name = `sk-${'a'.repeat(24)}`
        writeJson(fixture.dependencyInventoryReport, report)
      }],
      ['symlink', (fixture) => {
        const target = join(fixture.root, 'inventory-target.json')
        writeJson(target, validDependencyInventoryReport())
        rmSync(fixture.dependencyInventoryReport)
        symlinkSync(target, fixture.dependencyInventoryReport)
      }],
    ]

    for (const [label, mutate] of cases) {
      const fixture = createFixture()
      mutate(fixture)
      const result = runPolicy(fixture, [
        '--android-artifact', join(fixture.root, 'missing.apk'),
        '--ios-artifact', join(fixture.root, 'missing.ipa'),
      ])

      expect(result.status, label).not.toBe(0)
      expect(
        readReport(fixture).unsupportedChecks,
        label,
      ).toContainEqual(expect.objectContaining({
        id: 'sbom-license-tooling',
        status: 'blocked',
        releaseBlocking: true,
      }))
    }
  })

  it('redacts secret-shaped object keys from a tampered dependency inventory', () => {
    const fixture = createFixture()
    const secret = `sk-${'a'.repeat(24)}`
    const inventoryReport = validDependencyInventoryReport()
    inventoryReport.summary.dispositions = {
      allowed: inventoryReport.inventory.length,
      [secret]: 1,
    }
    writeJson(fixture.dependencyInventoryReport, inventoryReport)

    const result = runPolicy(fixture)
    expect(result.status).not.toBe(0)
    const rawReport = readFileSync(fixture.report, 'utf8')
    expect(rawReport).not.toContain(secret)
    expect(rawReport).not.toContain('"<redacted-key>"')
    const trustReport = JSON.parse(rawReport)
    expect(trustReport.unsupportedChecks).toContainEqual(expect.objectContaining({
      id: 'sbom-license-tooling',
      status: 'blocked',
      evidence: expect.objectContaining({
        dispositions: {
          allowed: inventoryReport.inventory.length,
          blocked: 0,
        },
      }),
    }))
  })

  it('records supplied Android and iOS release artifact hashes without absolute paths', () => {
    const fixture = createFixture()
    const androidAab = join(fixture.root, 'aurora-unsigned-release.aab')
    const androidApk = join(fixture.root, 'aurora-signed-release.apk')
    const iosIpa = join(fixture.root, 'aurora-release.ipa')
    const androidAabSha = writeArtifact(androidAab, 'android aab bytes')
    const androidApkSha = writeArtifact(androidApk, 'android apk bytes')
    const iosSha = writeArtifact(iosIpa, 'ios ipa bytes')
    const result = runPolicy(fixture, [
      '--source-commit', 'HEAD',
      '--android-artifact', [androidApk, androidAab].join(','),
      '--android-artifact-sha256', [androidApkSha, androidAabSha].join(','),
      '--ios-artifact', iosIpa,
      '--ios-artifact-sha256', iosSha,
    ])

    expect(result.status).toBe(0)
    const report = readReport(fixture)
    expect(report.blockers).toEqual([])
    expect(report.releaseBlocked).toBe(false)
    expect(report.status).toBe('passed')
    expect(report.unsupportedChecks).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'android-artifact-hash', status: 'passed', releaseBlocking: true }),
      expect.objectContaining({ id: 'ios-artifact-hash', status: 'passed', releaseBlocking: true }),
      expect.objectContaining({ id: 'sbom-license-tooling', status: 'passed', releaseBlocking: true }),
    ]))
    const android = report.unsupportedChecks.find((item: { id: string }) => item.id === 'android-artifact-hash')
    const ios = report.unsupportedChecks.find((item: { id: string }) => item.id === 'ios-artifact-hash')
    expect(android.artifacts.map((item: { artifactName: string }) => item.artifactName)).toEqual([
      'aurora-signed-release-apk',
      'aurora-unsigned-release-aab',
    ])
    expect(android.artifacts).toEqual([
      expect.objectContaining({
        artifactClass: 'android-mobile-release',
        sourceCommit: currentSourceCommit,
        sizeBytes: 'android apk bytes'.length,
        sha256: androidApkSha,
      }),
      expect.objectContaining({
        artifactClass: 'android-mobile-release',
        sourceCommit: currentSourceCommit,
        sizeBytes: 'android aab bytes'.length,
        sha256: androidAabSha,
      }),
    ])
    expect(ios.artifacts).toEqual([
      expect.objectContaining({
        artifactClass: 'ios-mobile-release',
        artifactName: 'aurora-release-ipa',
        sourceCommit: currentSourceCommit,
        sizeBytes: 'ios ipa bytes'.length,
        sha256: iosSha,
      }),
    ])
    const serialized = JSON.stringify(report)
    expect(serialized).not.toContain(fixture.root)
    expect(serialized).not.toContain(tmpdir())
  })

  it('redacts external sibling-prefix artifact paths without parent directory names', () => {
    const fixture = createFixture()
    const siblingRoot = mkdtempSync(`${repoRoot}-secret-`)
    const android = join(siblingRoot, 'aurora-sibling-release.apk')
    const ios = join(fixture.root, 'aurora-release.ipa')
    const androidSha = writeArtifact(android, 'android sibling bytes')
    const iosSha = writeArtifact(ios, 'ios bytes')
    const result = runPolicy(fixture, [
      '--source-commit', 'HEAD',
      '--android-artifact', android,
      '--android-artifact-sha256', androidSha,
      '--ios-artifact', ios,
      '--ios-artifact-sha256', iosSha,
    ])

    expect(result.status).toBe(0)
    const report = readReport(fixture)
    const androidCheck = report.unsupportedChecks.find((item: { id: string }) => item.id === 'android-artifact-hash')
    expect(androidCheck.artifacts).toEqual([
      expect.objectContaining({
        artifactName: 'aurora-sibling-release-apk',
        ref: '<external>/aurora-sibling-release-apk',
        sha256: androidSha,
      }),
    ])
    const serialized = JSON.stringify(report)
    expect(serialized).not.toContain(siblingRoot)
    expect(serialized).not.toContain('<repo-root>/../')
    expect(serialized).not.toContain('phase13-release-secret')
  })

  it('keeps Android and iOS artifact evidence release-blocking when artifacts are absent', () => {
    const fixture = createFixture()
    const result = runPolicy(fixture)

    expect(result.status).not.toBe(0)
    expect(readReport(fixture).blockers).toEqual([])
    expect(readReport(fixture).unsupportedChecks).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: 'android-artifact-hash',
        status: 'unsupported',
        releaseBlocking: true,
        artifacts: [],
      }),
      expect.objectContaining({
        id: 'ios-artifact-hash',
        status: 'unsupported',
        releaseBlocking: true,
        artifacts: [],
      }),
    ]))
  })

  it('rejects wrong, missing, empty, uninspectable, tampered, and duplicate mobile artifact inputs', () => {
    const cases: Array<[string, (fixture: Fixture) => string[]]> = [
      ['wrong extension', (fixture) => {
        const android = join(fixture.root, 'aurora-release.zip')
        const ios = join(fixture.root, 'aurora-release.ipa')
        writeArtifact(android, 'not an apk')
        const iosSha = writeArtifact(ios, 'ios bytes')
        return ['--android-artifact', android, '--ios-artifact', ios, '--ios-artifact-sha256', iosSha]
      }],
      ['missing path', (fixture) => {
        const ios = join(fixture.root, 'aurora-release.ipa')
        const iosSha = writeArtifact(ios, 'ios bytes')
        return ['--android-artifact', join(fixture.root, 'missing.apk'), '--ios-artifact', ios, '--ios-artifact-sha256', iosSha]
      }],
      ['empty file', (fixture) => {
        const android = join(fixture.root, 'empty.apk')
        const ios = join(fixture.root, 'aurora-release.ipa')
        writeFileSync(android, '')
        const iosSha = writeArtifact(ios, 'ios bytes')
        return ['--android-artifact', android, '--ios-artifact', ios, '--ios-artifact-sha256', iosSha]
      }],
      ['directory input', (fixture) => {
        const android = join(fixture.root, 'directory.apk')
        const ios = join(fixture.root, 'aurora-release.ipa')
        mkdirSync(android)
        const iosSha = writeArtifact(ios, 'ios bytes')
        return ['--android-artifact', android, '--ios-artifact', ios, '--ios-artifact-sha256', iosSha]
      }],
      ['symlink input', (fixture) => {
        const target = join(fixture.root, 'target.apk')
        const android = join(fixture.root, 'linked.apk')
        const ios = join(fixture.root, 'aurora-release.ipa')
        writeArtifact(target, 'android bytes')
        symlinkSync(target, android)
        const iosSha = writeArtifact(ios, 'ios bytes')
        return ['--android-artifact', android, '--ios-artifact', ios, '--ios-artifact-sha256', iosSha]
      }],
      ['tampered hash', (fixture) => {
        const android = join(fixture.root, 'aurora-release.apk')
        const ios = join(fixture.root, 'aurora-release.ipa')
        const androidSha = writeArtifact(android, 'original android bytes')
        writeArtifact(android, 'tampered android bytes')
        const iosSha = writeArtifact(ios, 'ios bytes')
        return ['--android-artifact', android, '--android-artifact-sha256', androidSha, '--ios-artifact', ios, '--ios-artifact-sha256', iosSha]
      }],
      ['duplicate path', (fixture) => {
        const android = join(fixture.root, 'aurora-release.apk')
        const ios = join(fixture.root, 'aurora-release.ipa')
        const androidSha = writeArtifact(android, 'android bytes')
        const iosSha = writeArtifact(ios, 'ios bytes')
        return ['--android-artifact', [android, android].join(','), '--android-artifact-sha256', [androidSha, androidSha].join(','), '--ios-artifact', ios, '--ios-artifact-sha256', iosSha]
      }],
      ['duplicate bytes', (fixture) => {
        const androidApk = join(fixture.root, 'aurora-release.apk')
        const androidAab = join(fixture.root, 'aurora-release.aab')
        const ios = join(fixture.root, 'aurora-release.ipa')
        const androidApkSha = writeArtifact(androidApk, 'same android bytes')
        const androidAabSha = writeArtifact(androidAab, 'same android bytes')
        const iosSha = writeArtifact(ios, 'ios bytes')
        return ['--android-artifact', [androidApk, androidAab].join(','), '--android-artifact-sha256', [androidApkSha, androidAabSha].join(','), '--ios-artifact', ios, '--ios-artifact-sha256', iosSha]
      }],
      ['expected hash count mismatch', (fixture) => {
        const androidApk = join(fixture.root, 'aurora-release.apk')
        const androidAab = join(fixture.root, 'aurora-release.aab')
        const ios = join(fixture.root, 'aurora-release.ipa')
        const androidApkSha = writeArtifact(androidApk, 'android apk bytes')
        writeArtifact(androidAab, 'android aab bytes')
        const iosSha = writeArtifact(ios, 'ios bytes')
        return ['--android-artifact', [androidApk, androidAab].join(','), '--android-artifact-sha256', androidApkSha, '--ios-artifact', ios, '--ios-artifact-sha256', iosSha]
      }],
      ['extra expected hash', (fixture) => {
        const android = join(fixture.root, 'aurora-release.apk')
        const ios = join(fixture.root, 'aurora-release.ipa')
        const androidSha = writeArtifact(android, 'android bytes')
        const iosSha = writeArtifact(ios, 'ios bytes')
        return ['--android-artifact', android, '--android-artifact-sha256', [androidSha, androidSha.replace(/^./, '0')].join(','), '--ios-artifact', ios, '--ios-artifact-sha256', iosSha]
      }],
      ['empty expected hash', (fixture) => {
        const android = join(fixture.root, 'aurora-release.apk')
        const ios = join(fixture.root, 'aurora-release.ipa')
        const androidSha = writeArtifact(android, 'android bytes')
        const iosSha = writeArtifact(ios, 'ios bytes')
        return ['--android-artifact', android, '--android-artifact-sha256', `${androidSha},`, '--ios-artifact', ios, '--ios-artifact-sha256', iosSha]
      }],
    ]

    for (const [label, extraArgsFor] of cases) {
      const fixture = createFixture()
      const result = runPolicy(fixture, ['--source-commit', 'HEAD', ...extraArgsFor(fixture)])

      expect(result.status, label).not.toBe(0)
      expect(readReport(fixture).blockers.map((item: { id: string }) => item.id), label).toContain(
        'android-artifact-hash',
      )
      expect(readReport(fixture).unsupportedChecks).toContainEqual(
        expect.objectContaining({ id: 'android-artifact-hash', status: 'blocked', releaseBlocking: true }),
      )
    }
  })

  it('rejects artifact evidence tied to invalid, nonexistent, or non-head source commits', () => {
    const cases = [
      ['empty commit', ''],
      ['invalid format', 'refs/heads/main'],
      ['nonexistent commit', '0000000000000000000000000000000000000000'],
      ['unrelated short commit', '2c0c861'],
    ]

    for (const [label, sourceCommit] of cases) {
      const fixture = createFixture()
      const android = join(fixture.root, 'aurora-release.apk')
      const ios = join(fixture.root, 'aurora-release.ipa')
      const androidSha = writeArtifact(android, 'android bytes')
      const iosSha = writeArtifact(ios, 'ios bytes')
      const result = runPolicy(fixture, [
        '--source-commit', sourceCommit,
        '--android-artifact', android,
        '--android-artifact-sha256', androidSha,
        '--ios-artifact', ios,
        '--ios-artifact-sha256', iosSha,
      ])

      expect(result.status, label).not.toBe(0)
      expect(readReport(fixture).blockers.map((item: { id: string }) => item.id), label).toEqual(
        expect.arrayContaining(['android-artifact-hash', 'ios-artifact-hash']),
      )
      expect(readReport(fixture).unsupportedChecks).toEqual(expect.arrayContaining([
        expect.objectContaining({ id: 'android-artifact-hash', status: 'blocked' }),
        expect.objectContaining({ id: 'ios-artifact-hash', status: 'blocked' }),
      ]))
    }
  })

  it('requires the exact package script and workflow command', () => {
    const fixture = createFixture()
    writeJson(fixture.packageJson, {
      scripts: { [expectedPackageScriptName]: 'node scripts/assert-release-trust-policy.mjs --dry-run' },
    })
    writeFileSync(fixture.workflow, `
name: Release
jobs:
  release-readiness:
    steps:
      - name: Release trust policy
        run: pnpm --filter @aurora/tauri-ui verify:static-release-trust-policy
      - name: Upload trust policy report
        if: always()
        uses: actions/upload-artifact@v4
        with:
          name: release-trust-policy
          path: ${expectedTrustReportPath}
          if-no-files-found: error
      - name: Check next semantic version
        run: ${expectedSemanticReleaseCommand}
`)
    const result = runPolicy(fixture)

    expect(result.status).not.toBe(0)
    const ids = readReport(fixture).blockers.map((item: { id: string }) => item.id)
    expect(ids).toContain('package-static-release-trust-policy-script')
    expect(ids).toContain('workflow-trust-gate-before-semver')
  })

  it('uses pnpm --dir for the workflow command because missing scripts fail closed', () => {
    const missingScript = '__aurora_missing_release_trust_policy_script__'
    const dirResult = spawnSync('pnpm', ['--dir', 'apps/aurora-tauri', 'run', missingScript], {
      cwd: repoRoot,
      encoding: 'utf8',
    })
    const filterResult = spawnSync('pnpm', ['--filter', '@aurora/tauri-ui', 'run', missingScript], {
      cwd: repoRoot,
      encoding: 'utf8',
    })

    expect(dirResult.status).not.toBe(0)
    expect(filterResult.status).toBe(0)
    expect(validWorkflow()).toContain(expectedTrustCommand)
  })

  it('fails closed on updater key, endpoint, and artifact settings', () => {
    const fixture = createFixture()
    writeJson(fixture.config, {
      ...productionTauriConfig(),
      bundle: { createUpdaterArtifacts: false },
      plugins: {
        updater: {
          pubkey: 'AURORA_RELEASE_PUBLIC_KEY_REPLACE_BEFORE_RELEASE',
          endpoints: ['http://updates.example.local/latest.json'],
        },
      },
    })
    const result = runPolicy(fixture)

    expect(result.status).not.toBe(0)
    expect(readReport(fixture).blockers.map((item: { id: string }) => item.id)).toEqual(
      expect.arrayContaining([
        'bundle-updater-artifacts',
        'updater-public-key-plausible',
        'updater-endpoint-1-https-production',
      ]),
    )
  })

  it('rejects non-public or special-purpose updater endpoint literals while accepting production HTTPS hosts', () => {
    const blockedLiteralEndpoints = [
      'https://localhost/latest.json',
      'https://localhost./latest.json',
      'https://releases.aurora.local./latest.json',
      'https://releases.aurora.test./latest.json',
      'https://updates.example.com./latest.json',
      'https://updates.example.net/latest.json',
      'https://updates.example.org/latest.json',
      'https://device.home.arpa/latest.json',
      'https://service.onion/latest.json',
      'https://name.alt/latest.json',
      'https://127.0.0.1/latest.json',
      'https://10.0.0.5/latest.json',
      'https://172.16.0.5/latest.json',
      'https://192.168.1.10/latest.json',
      'https://100.64.0.1/latest.json',
      'https://169.254.1.1/latest.json',
      'https://192.0.2.10/latest.json',
      'https://192.31.196.1/latest.json',
      'https://192.52.193.1/latest.json',
      'https://198.18.0.1/latest.json',
      'https://198.51.100.4/latest.json',
      'https://203.0.113.7/latest.json',
      'https://192.175.48.1/latest.json',
      'https://[::1]/latest.json',
      'https://[::]/latest.json',
      'https://[::8.8.8.8]/latest.json',
      'https://[64:ff9b::808:808]/latest.json',
      'https://[100::1]/latest.json',
      'https://[2001:db8::1]/latest.json',
      'https://[5f00::1]/latest.json',
      'https://[fc00::1]/latest.json',
      'https://[fd12::1]/latest.json',
      'https://[fe80::1]/latest.json',
      'https://[ff02::1]/latest.json',
      'https://[::ffff:127.0.0.1]/latest.json',
      'https://[::ffff:10.0.0.5]/latest.json',
      'https://[::ffff:8.8.8.8]/latest.json',
    ]

    for (const [index, endpoint] of blockedLiteralEndpoints.entries()) {
      const fixture = createFixture()
      writeJson(fixture.config, {
        ...productionTauriConfig(),
        plugins: {
          updater: {
            pubkey: realisticTauriUpdaterPubkey,
            endpoints: [endpoint],
          },
        },
      })
      const result = runPolicy(fixture)

      expect(result.status, `endpoint ${index + 1}: ${endpoint}`).not.toBe(0)
      expect(
        readReport(fixture).blockers.map((item: { id: string }) => item.id),
        `endpoint ${index + 1}: ${endpoint}`,
      ).toContain('updater-endpoint-1-https-production')
    }

    const fixture = createFixture()
    const result = runPolicy(fixture)
    expect(readReport(fixture).blockers.map((item: { id: string }) => item.id)).not.toContain(
      'updater-endpoint-1-https-production',
    )
    expect(result.status).not.toBe(0)

    for (const endpoint of [
      'https://8.8.8.8/latest.json',
      'https://100.63.255.255/latest.json',
      'https://100.128.0.1/latest.json',
      'https://192.31.195.255/latest.json',
      'https://192.31.197.1/latest.json',
      'https://notexample.com/latest.json',
      'https://example.com.evil/latest.json',
      'https://[2001:4860:4860::8888]/latest.json',
      'https://[2606:4700:4700::1111]/latest.json',
    ]) {
      const publicFixture = createFixture()
      writeJson(publicFixture.config, {
        ...productionTauriConfig(),
        plugins: {
          updater: {
            pubkey: realisticTauriUpdaterPubkey,
            endpoints: [endpoint],
          },
        },
      })
      const publicResult = runPolicy(publicFixture)
      expect(
        readReport(publicFixture).blockers.map((item: { id: string }) => item.id),
        `endpoint should be accepted: ${endpoint}`,
      ).not.toContain('updater-endpoint-1-https-production')
      expect(publicResult.status).not.toBe(0)
    }
  }, 60_000)

  it('requires desktop updater permissions and rejects updater leakage into mobile overlays', () => {
    const fixture = createFixture()
    writeJson(fixture.linux, { app: { security: { capabilities: ['aurora-main'] } } })
    writeJson(fixture.iosThin, { app: { security: { capabilities: ['aurora-ios-thin', 'aurora-desktop-updater'] } } })
    const result = runPolicy(fixture)

    expect(result.status).not.toBe(0)
    const ids = readReport(fixture).blockers.map((item: { id: string }) => item.id)
    expect(ids).toEqual(expect.arrayContaining([
      expect.stringContaining('desktop-updater-capability'),
      expect.stringContaining('mobile-no-updater-capability'),
    ]))
  })

  it('blocks missing Android and iOS hash/redaction/signing policy source invariants', () => {
    const fixture = createFixture()
    writeFileSync(fixture.androidArtifact, sourceWith('secretsRedacted: true\nredacted(path)\n'))
    writeFileSync(fixture.iosPreflight, sourceWith('const noop = true\n'))
    const result = runPolicy(fixture)

    expect(result.status).not.toBe(0)
    const ids = readReport(fixture).blockers.map((item: { id: string }) => item.id)
    expect(ids).toContain('android-config-hash')
    expect(ids).toContain('ios-strict-signing-policy')
    expect(readReport(fixture).unsupportedChecks).toContainEqual(
      expect.objectContaining({ id: 'android-artifact-hash', status: 'unsupported', releaseBlocking: true }),
    )
  })

  it('does not satisfy Android and iOS source invariants from comments only', () => {
    const fixture = createFixture()
    writeFileSync(fixture.androidBuild, sourceWith('// createHash("sha256")\n// configSha256\n// secretsRedacted: true\n// redacted(path)\n'))
    writeFileSync(fixture.androidArtifact, sourceWith('/* createHash("sha256")\nconfigSha256\nartifactSha256\nsecretsRedacted: true\nredacted(path) */\n'))
    writeFileSync(fixture.androidPreflight, sourceWith('// const strict = true\n// ANDROID_KEYSTORE_PATH\n// AURORA_ANDROID_SIGNING_CONFIGURED\n// secretsRedacted: true\n'))
    writeFileSync(fixture.iosBuild, sourceWith('// createHash("sha256")\n// configSha256\n// secretsRedacted: true\n// redacted(path)\n'))
    writeFileSync(fixture.iosEvidence, sourceWith('// ipaSha256\n// secretsRedacted === true\n// redacted(path)\n'))
    writeFileSync(fixture.iosPreflight, sourceWith('/* requireSigningEnv\nAPPLE_API_KEY_ID\nAPPLE_API_ISSUER\nAPPLE_API_PRIVATE_KEY\nsecretsRedacted: true */\n'))
    const result = runPolicy(fixture)

    expect(result.status).not.toBe(0)
    const ids = readReport(fixture).blockers.map((item: { id: string }) => item.id)
    expect(ids).toEqual(expect.arrayContaining([
      'android-config-hash',
      'android-redaction',
      'android-strict-signing-policy',
      'ios-config-hash',
      'ios-redaction',
      'ios-strict-signing-policy',
    ]))
    expect(readReport(fixture).unsupportedChecks).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'android-artifact-hash', status: 'unsupported', releaseBlocking: true }),
      expect.objectContaining({ id: 'ios-artifact-hash', status: 'unsupported', releaseBlocking: true }),
    ]))
  })

  it('does not satisfy Android source invariants from hostile quoted Kotlin or template strings', () => {
    const fixture = createFixture()
    writeFileSync(fixture.androidBuild, sourceWith(`
const kotlinHostile = """
createHash("sha256")
configSha256
secretsRedacted: true
redacted(path)
"""
const templateHostile = \`createHash("sha256")
configSha256
secretsRedacted: true
redacted(path)\`
`))
    writeFileSync(fixture.androidArtifact, sourceWith(`
val hostile = """
createHash("sha256")
configSha256
artifactSha256
secretsRedacted: true
redacted(path)
"""
`))
    writeFileSync(fixture.androidPreflight, sourceWith(`
const hostile = "const strict = true ANDROID_KEYSTORE_PATH TAURI_ANDROID_KEYSTORE_PATH AURORA_ANDROID_SIGNING_CONFIGURED secretsRedacted: true"
`))
    const result = runPolicy(fixture)

    expect(result.status).not.toBe(0)
    const ids = readReport(fixture).blockers.map((item: { id: string }) => item.id)
    expect(ids).toEqual(expect.arrayContaining([
      'android-config-hash',
      'android-redaction',
      'android-strict-signing-policy',
    ]))
    expect(readReport(fixture).unsupportedChecks).toContainEqual(
      expect.objectContaining({ id: 'android-artifact-hash', status: 'unsupported', releaseBlocking: true }),
    )
  })

  it('does not satisfy iOS source invariants from hostile quoted Swift or template strings', () => {
    const fixture = createFixture()
    writeFileSync(fixture.iosBuild, sourceWith(`
let swiftHostile = """
createHash("sha256")
configSha256
secretsRedacted: true
redacted(path)
"""
`))
    writeFileSync(fixture.iosEvidence, sourceWith(`
let hostile = "ipaSha256 secretsRedacted === true redacted(path)"
`))
    writeFileSync(fixture.iosPreflight, sourceWith(`
const templateHostile = \`requireSigningEnv
APPLE_API_KEY_ID
APPLE_API_ISSUER
APPLE_API_KEY_PATH
APPLE_API_PRIVATE_KEY
secretsRedacted: true\`
`))
    const result = runPolicy(fixture)

    expect(result.status).not.toBe(0)
    const ids = readReport(fixture).blockers.map((item: { id: string }) => item.id)
    expect(ids).toEqual(expect.arrayContaining([
      'ios-config-hash',
      'ios-redaction',
      'ios-strict-signing-policy',
    ]))
    expect(readReport(fixture).unsupportedChecks).toContainEqual(
      expect.objectContaining({ id: 'ios-artifact-hash', status: 'unsupported', releaseBlocking: true }),
    )
  })

  it('reports Android and iOS artifact hash evidence as unsupported even with null source bait', () => {
    const fixture = createFixture()
    writeFileSync(fixture.androidArtifact, sourceWith(`
const artifactSha256 = null
const archiveSha256 = null
const fileSha256 = null
secretsRedacted: true
redacted(path)
configSha256
`))
    writeFileSync(fixture.iosEvidence, sourceWith(`
const ipaSha256 = null
const appSha256 = null
secretsRedacted === true
redacted(path)
`))
    const result = runPolicy(fixture)

    expect(result.status).not.toBe(0)
    expect(readReport(fixture).blockers.map((item: { id: string }) => item.id)).not.toEqual(
      expect.arrayContaining(['android-artifact-hash', 'ios-artifact-hash']),
    )
    expect(readReport(fixture).unsupportedChecks).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'android-artifact-hash', status: 'unsupported', releaseBlocking: true }),
      expect.objectContaining({ id: 'ios-artifact-hash', status: 'unsupported', releaseBlocking: true }),
    ]))
  })

  it('rejects comment-only or after-semver workflow placement and requires always-uploaded reports', () => {
    const fixture = createFixture()
    writeFileSync(fixture.workflow, `
name: Release
jobs:
  release-readiness:
    steps:
      # ${expectedTrustCommand}
      - name: Check next semantic version
        run: echo semver
      - name: Late trust gate
        run: ${expectedTrustCommand}
      - uses: actions/upload-artifact@v4
        with:
          name: release-trust-policy
`)
    const result = runPolicy(fixture)

    expect(result.status).not.toBe(0)
    const ids = readReport(fixture).blockers.map((item: { id: string }) => item.id)
    expect(ids).toContain('workflow-trust-gate-before-semver')
    expect(ids).toContain('workflow-trust-report-upload-always')
  })

  it('does not accept an unrelated always-upload as the trust report upload', () => {
    const fixture = createFixture()
    writeFileSync(fixture.workflow, `
name: Release
jobs:
  release-readiness:
    steps:
      - name: Release trust policy
        run: ${expectedTrustCommand}
      - name: Upload unrelated diagnostics
        if: always()
        uses: actions/upload-artifact@v4
        with:
          name: unrelated-diagnostics
          path: reports/unrelated.json
      - name: Upload trust policy report
        uses: actions/upload-artifact@v4
        with:
          name: release-trust-policy
          path: ${expectedTrustReportPath}
      - name: Check next semantic version
        run: ${expectedSemanticReleaseCommand}
`)
    const result = runPolicy(fixture)

    expect(result.status).not.toBe(0)
    expect(readReport(fixture).blockers.map((item: { id: string }) => item.id)).toContain(
      'workflow-trust-report-upload-always',
    )
  })

  it('allows unrelated artifact uploads after the canonical trust report upload', () => {
    const fixture = createFixture()
    writeFileSync(
      fixture.workflow,
      validWorkflow().replace('      - name: Check next semantic version\n', `      - name: Upload rollback policy report
        if: always()
        uses: actions/upload-artifact@v4
        with:
          name: static-release-rollback-policy-report
          path: apps/aurora-tauri/reports/release-rollback-plan-policy.json
      - name: Check next semantic version
`),
    )
    const result = runPolicy(fixture)

    expect(result.status).not.toBe(0)
    expect(readReport(fixture).blockers.map((item: { id: string }) => item.id)).not.toContain(
      'workflow-trust-report-upload-always',
    )
  })

  it('rejects trust report uploads that only match by artifact name or arbitrary scalar text', () => {
    const fixture = createFixture()
    writeFileSync(fixture.workflow, `
name: Release
jobs:
  release-readiness:
    steps:
      - name: Release trust policy
        run: ${expectedTrustCommand}
      - name: Upload name-only trust policy report
        if: always()
        uses: actions/upload-artifact@v4
        with:
          name: release-trust-policy
          path: reports/unrelated.json
      - name: Upload unrelated artifact with report text
        if: always()
        uses: actions/upload-artifact@v4
        with:
          name: unrelated-diagnostics
          path: ${expectedTrustReportPath}.bak
          note: ${expectedTrustReportPath}
      - name: Check next semantic version
        run: echo semver
`)
    const result = runPolicy(fixture)

    expect(result.status).not.toBe(0)
    expect(readReport(fixture).blockers.map((item: { id: string }) => item.id)).toContain(
      'workflow-trust-report-upload-always',
    )
  })

  it('rejects workflow gates hidden in comments, quoted shell text, or another job', () => {
    const fixture = createFixture()
    writeFileSync(fixture.workflow, `
name: Release
jobs:
  # release-readiness:
  unrelated:
    steps:
      - name: Release trust policy in the wrong job
        run: ${expectedTrustCommand}
      - name: Upload trust policy report in the wrong job
        if: always()
        uses: actions/upload-artifact@v4
        with:
          name: release-trust-policy
          path: ${expectedTrustReportPath}
  release-readiness:
    steps:
      - name: Quoted occurrence is not the trust command
        run: echo "${expectedTrustCommand}"
      - name: Commented block occurrence is not the trust command
        run: |
          # ${expectedTrustCommand}
          echo done
      - name: Check next semantic version
        run: echo semver
`)
    const result = runPolicy(fixture)

    expect(result.status).not.toBe(0)
    const ids = readReport(fixture).blockers.map((item: { id: string }) => item.id)
    expect(ids).toContain('workflow-trust-gate-before-semver')
    expect(ids).toContain('workflow-trust-report-upload-always')
  })

  it('rejects trusted gate commands hidden in non-executing block scalar text', () => {
    const hostileRuns = [
      ['false conditional', `if false; then
          ${expectedTrustCommand}
          fi`],
      ['heredoc text', `cat <<'EOF'
          ${expectedTrustCommand}
          EOF`],
      ['preceding exit', `exit 0
          ${expectedTrustCommand}`],
    ]

    for (const [label, runBody] of hostileRuns) {
      const fixture = createFixture()
      writeFileSync(fixture.workflow, `
name: Release
jobs:
  release-readiness:
    steps:
      - name: Release trust policy
        run: |
          ${runBody}
      - name: Upload trust policy report
        if: always()
        uses: actions/upload-artifact@v4
        with:
          name: release-trust-policy
          path: ${expectedTrustReportPath}
      - name: Check next semantic version
        run: echo semver
`)
      const result = runPolicy(fixture)

      expect(result.status, label).not.toBe(0)
      expect(readReport(fixture).blockers.map((item: { id: string }) => item.id), label).toContain(
        'workflow-trust-gate-before-semver',
      )
    }
  })

  it('requires the trust gate to be the first run step after canonical setup actions', () => {
    const cases = [
      ['pre-gate wrapper run', validWorkflow().replace('      - name: Release trust policy\n', `      - name: Wrapper before gate\n        run: echo preparing\n      - name: Release trust policy\n`)],
      ['pre-gate mutation run', validWorkflow().replace('      - name: Release trust policy\n', `      - name: Mutate report before gate\n        run: echo "{}" > ${expectedTrustReportPath}\n      - name: Release trust policy\n`)],
      ['unexpected pre-gate action', validWorkflow().replace('      - name: Release trust policy\n', `      - name: Unexpected action\n        uses: cycjimmy/semantic-release-action@v4\n      - name: Release trust policy\n`)],
    ]

    for (const [label, workflow] of cases) {
      const fixture = createFixture()
      writeFileSync(fixture.workflow, workflow)
      const result = runPolicy(fixture)

      expect(result.status, label).not.toBe(0)
      expect(readReport(fixture).blockers.map((item: { id: string }) => item.id), label).toContain(
        'workflow-trust-gate-first-run',
      )
    }
  })

  it('allows only canonical setup actions before the trust gate', () => {
    const fixture = createFixture()
    writeFileSync(fixture.workflow, validWorkflow())
    const result = runPolicy(fixture)

    expect(result.status).not.toBe(0)
    expect(readReport(fixture).blockers.map((item: { id: string }) => item.id)).not.toContain(
      'workflow-trust-gate-first-run',
    )
  })

  it('requires canonical dependency inventory generation and always-upload immediately before the trust gate', () => {
    const cases = [
      ['missing inventory command', validWorkflow().replace(
        `      - name: Release dependency inventory\n        run: ${expectedDependencyInventoryCommand}\n`,
        '',
      )],
      ['inventory upload not always', validWorkflow().replace(
        `      - name: Upload release dependency inventory report\n        if: always()`,
        '      - name: Upload release dependency inventory report',
      )],
      ['extra step before trust', validWorkflow().replace(
        '      - name: Release trust policy\n',
        '      - name: Unexpected inventory mutation\n        run: echo tamper\n      - name: Release trust policy\n',
      )],
      ['inventory command drift', validWorkflow().replace(
        expectedDependencyInventoryCommand,
        `${expectedDependencyInventoryCommand} --report /tmp/spoof.json`,
      )],
    ]

    for (const [label, workflow] of cases) {
      const fixture = createFixture()
      writeFileSync(fixture.workflow, workflow)
      const result = runPolicy(fixture)

      expect(result.status, label).not.toBe(0)
      expect(
        readReport(fixture).blockers.map((item: { id: string }) => item.id),
        label,
      ).toContain('workflow-dependency-inventory-report-upload-always')
    }
  })

  it('rejects altered canonical setup inputs before the trust gate', () => {
    const cases = [
      ['checkout repository', validWorkflow().replace('          fetch-depth: 0', `          fetch-depth: 0
          repository: attacker/fork`)],
      ['checkout ref', validWorkflow().replace('          fetch-depth: 0', `          fetch-depth: 0
          ref: attacker`)],
      ['checkout path', validWorkflow().replace('          fetch-depth: 0', `          fetch-depth: 0
          path: shadow`)],
      ['checkout token', validWorkflow().replace('          fetch-depth: 0', `          fetch-depth: 0
          token: \${{ secrets.ATTACKER_TOKEN }}`)],
      ['python version change', validWorkflow().replace('          python-version: "3.11.11"', '          python-version: "3.12"')],
      ['pnpm run install', validWorkflow().replace('        uses: pnpm/action-setup@v4', `        uses: pnpm/action-setup@v4
        with:
          run_install: true`)],
      ['extra setup action', validWorkflow().replace('      - name: Release trust policy\n', `      - name: Extra setup action
        uses: actions/cache@v4
      - name: Release trust policy
`)],
    ]

    for (const [label, workflow] of cases) {
      const fixture = createFixture()
      writeFileSync(fixture.workflow, workflow)
      const result = runPolicy(fixture)

      expect(result.status, label).not.toBe(0)
      expect(readReport(fixture).blockers.map((item: { id: string }) => item.id), label).toContain(
        'workflow-trust-gate-first-run',
      )
    }
  }, 15_000)

  it('rejects trust gate steps with any noncanonical execution fields', () => {
    const hostileControls = [
      ['if false', '        if: false'],
      ['canonical false continue', '        continue-on-error: false'],
      ['continue on error', '        continue-on-error: true'],
      ['continue expression', '        continue-on-error: ${{ true }}'],
      ['continue tagged true', '        continue-on-error: !!bool true'],
      ['continue non-boolean', '        continue-on-error: 0'],
      ['continue quoted false', '        continue-on-error: "false"'],
      ['custom shell', '        shell: bash'],
      ['node preload env', `        env:
          NODE_OPTIONS: --require ./scripts/preload.js`],
      ['path override env', `        env:
          PATH: ./attacker-bin`],
      ['unexpected with', `        with:
          attacker: true`],
    ]

    for (const [label, controlLine] of hostileControls) {
      const fixture = createFixture()
      writeFileSync(fixture.workflow, `
name: Release
jobs:
  release-readiness:
    steps:
      - name: Release trust policy
${controlLine}
        run: ${expectedTrustCommand}
      - name: Upload trust policy report
        if: always()
        uses: actions/upload-artifact@v4
        with:
          name: release-trust-policy
          path: ${expectedTrustReportPath}
      - name: Check next semantic version
        run: echo semver
`)
      const result = runPolicy(fixture)

      expect(result.status, label).not.toBe(0)
      expect(readReport(fixture).blockers.map((item: { id: string }) => item.id), label).toContain(
        'workflow-trust-gate-before-semver',
      )
    }
  }, 15_000)

  it('accepts canonical false continue-on-error on the trust report upload', () => {
    const fixture = createFixture()
    writeFileSync(
      fixture.workflow,
      validWorkflow()
        .replace(`      - name: Upload trust policy report
        if: always()`, `      - name: Upload trust policy report
        if: always()
        continue-on-error: false`),
    )
    const result = runPolicy(fixture)

    expect(result.status).not.toBe(0)
    const report = readReport(fixture)
    expect(report.blockers).toEqual([])
    expect(report.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'workflow-trust-gate-before-semver', status: 'passed' }),
        expect.objectContaining({ id: 'workflow-trust-report-upload-always', status: 'passed' }),
      ]),
    )
  })

  it('requires the trust report upload action to use exactly actions/upload-artifact v4', () => {
    const fixture = createFixture()
    writeFileSync(fixture.workflow, `
name: Release
jobs:
  release-readiness:
    steps:
      - name: Release trust policy
        run: ${expectedTrustCommand}
      - name: Upload trust policy report
        if: always()
        uses: actions/upload-artifact@v5
        with:
          name: release-trust-policy
          path: ${expectedTrustReportPath}
      - name: Check next semantic version
        run: echo semver
`)
    const result = runPolicy(fixture)

    expect(result.status).not.toBe(0)
    expect(readReport(fixture).blockers.map((item: { id: string }) => item.id)).toContain(
      'workflow-trust-report-upload-always',
    )
  })

  it('requires trust report upload immediately after the trust gate', () => {
    const fixture = createFixture()
    writeFileSync(fixture.workflow, `
name: Release
jobs:
  release-readiness:
    steps:
      - name: Release trust policy
        run: ${expectedTrustCommand}
      - name: Spoof report before upload
        run: echo "{}" > ${expectedTrustReportPath}
      - name: Upload trust policy report
        if: always()
        uses: actions/upload-artifact@v4
        with:
          name: release-trust-policy
          path: ${expectedTrustReportPath}
          if-no-files-found: error
      - name: Check next semantic version
        run: ${expectedSemanticReleaseCommand}
`)
    const result = runPolicy(fixture)

    expect(result.status).not.toBe(0)
    expect(readReport(fixture).blockers.map((item: { id: string }) => item.id)).toContain(
      'workflow-trust-report-upload-always',
    )
  })

  it('requires trust report upload to fail if the canonical report file is missing', () => {
    const fixture = createFixture()
    writeFileSync(
      fixture.workflow,
      validWorkflow().replace(
        `          path: ${expectedTrustReportPath}\n          if-no-files-found: error\n`,
        `          path: ${expectedTrustReportPath}\n`,
      ),
    )
    const result = runPolicy(fixture)

    expect(result.status).not.toBe(0)
    expect(readReport(fixture).blockers.map((item: { id: string }) => item.id)).toContain(
      'workflow-trust-report-upload-always',
    )
  })

  it('rejects duplicate trust report uploads and later report overwrites', () => {
    const duplicateUpload = validWorkflow().replace('      - name: Check next semantic version\n', `      - name: Duplicate trust report upload
        if: always()
        uses: actions/upload-artifact@v4
        with:
          name: release-trust-policy
          path: ${expectedTrustReportPath}
          if-no-files-found: error
      - name: Check next semantic version
`)
    const overwriteAfterUpload = validWorkflow().replace('      - name: Check next semantic version\n', `      - name: Overwrite report after upload
        run: echo "{}" > ${expectedTrustReportPath}
      - name: Check next semantic version
`)

    for (const [label, workflow] of [
      ['duplicate upload', duplicateUpload],
      ['overwrite after upload', overwriteAfterUpload],
    ]) {
      const fixture = createFixture()
      writeFileSync(fixture.workflow, workflow)
      const result = runPolicy(fixture)

      expect(result.status, label).not.toBe(0)
      expect(readReport(fixture).blockers.map((item: { id: string }) => item.id), label).toContain(
        'workflow-trust-report-upload-always',
      )
    }
  })

  it('rejects trust report upload steps with non-canonical continue-on-error controls', () => {
    const hostileControls = [
      ['truthy', '        continue-on-error: true'],
      ['expression', '        continue-on-error: ${{ true }}'],
      ['tagged true', '        continue-on-error: !!bool true'],
      ['non-boolean', '        continue-on-error: 0'],
      ['quoted false', '        continue-on-error: "false"'],
    ]

    for (const [label, controlLine] of hostileControls) {
      const fixture = createFixture()
      writeFileSync(fixture.workflow, `
name: Release
jobs:
  release-readiness:
    steps:
      - name: Release trust policy
        run: ${expectedTrustCommand}
      - name: Upload trust policy report
        if: always()
${controlLine}
        uses: actions/upload-artifact@v4
        with:
          name: release-trust-policy
          path: ${expectedTrustReportPath}
      - name: Check next semantic version
        run: echo semver
`)
      const result = runPolicy(fixture)

      expect(result.status, label).not.toBe(0)
      expect(readReport(fixture).blockers.map((item: { id: string }) => item.id), label).toContain(
        'workflow-trust-report-upload-always',
      )
    }
  })

  it('rejects semantic-release version commands that run before the trust gate under another name', () => {
    const fixture = createFixture()
    writeFileSync(fixture.workflow, `
name: Release
jobs:
  release-readiness:
    steps:
      - name: Prepare version
        run: |
          version=$(uv run semantic-release version --print --no-commit --no-tag --no-push --no-vcs-release)
      - name: Release trust policy
        run: ${expectedTrustCommand}
      - name: Upload trust policy report
        if: always()
        uses: actions/upload-artifact@v4
        with:
          name: release-trust-policy
          path: ${expectedTrustReportPath}
      - name: Check next semantic version
        run: echo fake name after trust gate
`)
    const result = runPolicy(fixture)

    expect(result.status).not.toBe(0)
    expect(readReport(fixture).blockers.map((item: { id: string }) => item.id)).toContain(
      'workflow-trust-gate-before-semver',
    )
  })

  it('rejects early semantic-release version commands hidden by every valid block scalar header style', () => {
    const blockCases: Array<[string, string, string[]]> = [
      ['folded clip', '>', ['uv run semantic-release', 'version --print --no-commit --no-tag --no-push --no-vcs-release']],
      ['folded strip', '>-', ['uv run semantic-release', 'version --print --no-commit --no-tag --no-push --no-vcs-release']],
      ['folded keep', '>+', ['uv run semantic-release', 'version --print --no-commit --no-tag --no-push --no-vcs-release']],
      ['literal strip', '|-', ['uv run semantic-release version --print --no-commit --no-tag --no-push --no-vcs-release']],
      ['literal keep', '|+', ['uv run semantic-release version --print --no-commit --no-tag --no-push --no-vcs-release']],
    ]

    for (const [label, header, commandLines] of blockCases) {
      const fixture = createFixture()
      writeFileSync(fixture.workflow, `
name: Release
jobs:
  release-readiness:
    steps:
      - name: Prepare version
        run: ${header}
${commandLines.map((line) => `          ${line}`).join('\n')}
      - name: Release trust policy
        run: ${expectedTrustCommand}
      - name: Upload trust policy report
        if: always()
        uses: actions/upload-artifact@v4
        with:
          name: release-trust-policy
          path: ${expectedTrustReportPath}
      - name: Check next semantic version
        run: echo fake name after trust gate
`)
      const result = runPolicy(fixture)

      expect(result.status, label).not.toBe(0)
      expect(readReport(fixture).blockers.map((item: { id: string }) => item.id), label).toContain(
        'workflow-trust-gate-before-semver',
      )
    }
  })

  it('rejects early semantic-release version commands hidden by shell line continuation', () => {
    const fixture = createFixture()
    writeFileSync(fixture.workflow, `
name: Release
jobs:
  release-readiness:
    steps:
      - name: Prepare version
        run: |
          uv \\
          run semantic-release version --print --no-commit --no-tag --no-push --no-vcs-release
      - name: Release trust policy
        run: ${expectedTrustCommand}
      - name: Upload trust policy report
        if: always()
        uses: actions/upload-artifact@v4
        with:
          name: release-trust-policy
          path: ${expectedTrustReportPath}
      - name: Check next semantic version
        run: echo fake name after trust gate
`)
    const result = runPolicy(fixture)

    expect(result.status).not.toBe(0)
    expect(readReport(fixture).blockers.map((item: { id: string }) => item.id)).toContain(
      'workflow-trust-gate-before-semver',
    )
  })

  it('rejects alternate semantic-release entrypoints that run before the trust gate', () => {
    const entrypoints = [
      ['uv python module', 'run', 'uv run python -m semantic_release version --print --no-commit'],
      ['uv python module options', 'run', 'uv run python -m semantic_release -vv version --print --no-commit'],
      ['python module', 'run', 'python -m semantic_release version --print --no-commit'],
      ['python module options', 'run', 'python -m semantic_release -vv version --print --no-commit'],
      ['direct underscore cli', 'run', 'semantic_release version --print --no-commit'],
      ['direct underscore cli options', 'run', 'semantic_release -vv version --print --no-commit'],
      ['direct hyphen cli', 'run', 'semantic-release version --print --no-commit'],
      ['direct hyphen cli options', 'run', 'semantic-release -vv version --print --no-commit'],
      ['python semantic release action', 'uses', 'python-semantic-release/python-semantic-release@v10.4.1'],
    ]

    for (const [label, key, value] of entrypoints) {
      const fixture = createFixture()
      writeFileSync(fixture.workflow, `
name: Release
jobs:
  release-readiness:
    steps:
      - name: Prepare version
        ${key}: ${value}
      - name: Release trust policy
        run: ${expectedTrustCommand}
      - name: Upload trust policy report
        if: always()
        uses: actions/upload-artifact@v4
        with:
          name: release-trust-policy
          path: ${expectedTrustReportPath}
      - name: Check next semantic version
        run: ${expectedSemanticReleaseCommand}
`)
      const result = runPolicy(fixture)

      expect(result.status, label).not.toBe(0)
      expect(readReport(fixture).blockers.map((item: { id: string }) => item.id), label).toContain(
        'workflow-trust-gate-before-semver',
      )
    }
  }, 15_000)

  it('rejects create-release jobs that are not gated by release-readiness success', () => {
    const hostileWorkflows = [
      ['missing needs', validWorkflow().replace('    needs: release-readiness\n', '')],
      ['alternate needs', validWorkflow().replace('    needs: release-readiness', '    needs: package-release')],
      ['missing if', validWorkflow().replace('    if: success() && inputs.dry_run == false\n', '')],
      ['success only if', validWorkflow().replace('    if: success() && inputs.dry_run == false', '    if: success()')],
      ['always if', validWorkflow().replace('    if: success() && inputs.dry_run == false', '    if: always()')],
      ['not cancelled if', validWorkflow().replace('    if: success() && inputs.dry_run == false', '    if: ${{ !cancelled() }}')],
    ]

    for (const [label, workflow] of hostileWorkflows) {
      const fixture = createFixture()
      writeFileSync(fixture.workflow, workflow)
      const result = runPolicy(fixture)

      expect(result.status, label).not.toBe(0)
      expect(readReport(fixture).blockers.map((item: { id: string }) => item.id), label).toContain(
        'workflow-create-release-needs-readiness',
      )
    }
  })

  it('rejects noncanonical create-release job-level controls and permissions', () => {
    const cases = [
      ['continue on error', validWorkflow().replace('    timeout-minutes: 20\n', `    timeout-minutes: 20
    continue-on-error: true
`)],
      ['job env', validWorkflow().replace('    timeout-minutes: 20\n', `    timeout-minutes: 20
    env:
      NODE_OPTIONS: --require ./scripts/preload.js
`)],
      ['job defaults', validWorkflow().replace('    timeout-minutes: 20\n', `    timeout-minutes: 20
    defaults:
      run:
        shell: attacker-shell
`)],
      ['runner drift', validWorkflow().replace(
        '  create-release:\n    name: Create semantic release\n    runs-on: ubuntu-latest',
        '  create-release:\n    name: Create semantic release\n    runs-on: self-hosted',
      )],
      ['timeout drift', validWorkflow().replace('    timeout-minutes: 20', '    timeout-minutes: 120')],
      ['permission drift', validWorkflow().replace('      contents: write', '      contents: read')],
      ['tagged permission key', validWorkflow().replace('      contents: write', '      !str contents: write')],
      ['extra permission', validWorkflow().replace('      id-token: write', `      id-token: write
      actions: write`)],
    ]

    for (const [label, workflow] of cases) {
      const fixture = createFixture()
      writeFileSync(fixture.workflow, workflow)
      const result = runPolicy(fixture)

      expect(result.status, label).not.toBe(0)
      expect(readReport(fixture).blockers.map((item: { id: string }) => item.id), label).toContain(
        'workflow-create-release-needs-readiness',
      )
    }
  }, 15_000)

  it('rejects inherited workflow controls and release-readiness job drift', () => {
    const cases = [
      ['workflow PATH', validWorkflow().replace('jobs:\n', `env:
  PATH: ./attacker-bin:\${{ env.PATH }}
jobs:
`)],
      ['workflow NODE_OPTIONS', validWorkflow().replace('jobs:\n', `env:
  NODE_OPTIONS: --require ./scripts/preload.js
jobs:
`)],
      ['readiness PATH', validWorkflow().replace('  release-readiness:\n', `  release-readiness:
    env:
      PATH: ./attacker-bin:\${{ env.PATH }}
`)],
      ['readiness NODE_OPTIONS', validWorkflow().replace('  release-readiness:\n', `  release-readiness:
    env:
      NODE_OPTIONS: --require ./scripts/preload.js
`)],
      ['workflow defaults', validWorkflow().replace('jobs:\n', `defaults:
  run:
    working-directory: attacker
jobs:
`)],
      ['workflow permissions missing', validWorkflow().replace(`permissions:
  contents: read
`, '')],
      ['workflow permissions write', validWorkflow().replace(`permissions:
  contents: read`, `permissions:
  contents: write`)],
      ['workflow permissions extra', validWorkflow().replace('  contents: read', `  contents: read
  id-token: write`)],
      ['workflow permissions scalar', validWorkflow().replace(`permissions:
  contents: read`, 'permissions: write-all')],
      ['workflow permissions inline', validWorkflow().replace(`permissions:
  contents: read`, 'permissions: {contents: read}')],
      ['readiness defaults', validWorkflow().replace('    steps:\n', `    defaults:
      run:
        working-directory: attacker
    steps:
`)],
      ['readiness runner drift', validWorkflow().replace('    runs-on: ubuntu-latest', '    runs-on: self-hosted')],
      ['readiness timeout drift', validWorkflow().replace('    timeout-minutes: 45', '    timeout-minutes: 120')],
      ['readiness continue', validWorkflow().replace('    timeout-minutes: 45\n', `    timeout-minutes: 45
    continue-on-error: true
`)],
      ['readiness container', validWorkflow().replace('    timeout-minutes: 45\n', `    timeout-minutes: 45
    container: attacker/image:latest
`)],
    ]

    for (const [label, workflow] of cases) {
      const fixture = createFixture()
      writeFileSync(fixture.workflow, workflow)
      const result = runPolicy(fixture)

      expect(result.status, label).not.toBe(0)
      expect(readReport(fixture).blockers.map((item: { id: string }) => item.id), label).toContain(
        'workflow-release-readiness-unique-structure',
      )
    }
  }, 15_000)

  it('accepts the canonical create-release condition with GitHub expression delimiters', () => {
    const fixture = createFixture()
    writeFileSync(
      fixture.workflow,
      validWorkflow().replace(
        '    if: success() && inputs.dry_run == false',
        '    if: ${{ success() && inputs.dry_run == false }}',
      ),
    )
    const result = runPolicy(fixture)

    expect(result.status).not.toBe(0)
    expect(readReport(fixture).blockers.map((item: { id: string }) => item.id)).not.toContain(
      'workflow-create-release-needs-readiness',
    )
  })

  it('rejects renamed or extra release-producing jobs', () => {
    const renamedReleaseJob = validWorkflow().replace('  create-release:', '  publish-release:')
    const duplicateReleaseJob = `${validWorkflow()}
  publish-release:
    needs: release-readiness
    if: success() && inputs.dry_run == false
    steps:
      - uses: python-semantic-release/python-semantic-release@v10.4.1
`
    const extraJob = (step: string) => `${validWorkflow()}
  rogue-release:
    runs-on: ubuntu-latest
    needs: release-readiness
    permissions:
      contents: write
    steps:
${step}
`
    const cases = [
      ['renamed action job', renamedReleaseJob],
      ['duplicate release producer', duplicateReleaseJob],
      ['renamed publish signal job', renamedReleaseJob.replace('        uses: python-semantic-release/python-semantic-release@v10.4.1', '        run: semantic-release publish')],
      ['extra gh release job', extraJob('      - run: gh release create v9.9.9 --notes owned')],
      ['extra release action job', extraJob('      - uses: softprops/action-gh-release@v2')],
      ['extra release API job', extraJob('      - run: curl -X POST https://api.github.com/repos/example/project/releases')],
      ['extra benign job', extraJob('      - run: echo not-a-release')],
    ]

    for (const [label, workflow] of cases) {
      const fixture = createFixture()
      writeFileSync(fixture.workflow, workflow)
      const result = runPolicy(fixture)

      expect(result.status, label).not.toBe(0)
      expect(readReport(fixture).blockers.map((item: { id: string }) => item.id), label).toContain(
        'workflow-create-release-needs-readiness',
      )
    }
  })

  it('rejects matrix and reusable workflow release job forms', () => {
    const cases = [
      ['strategy matrix', validWorkflow().replace(`    timeout-minutes: 20
`, `    timeout-minutes: 20
    strategy:
      matrix:
        os: [ubuntu-latest]
`)],
      ['job-level uses', validWorkflow().replace(`    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0
          token: \${{ secrets.PAT_RELEASE || github.token }}
      - name: Configure Git
        run: |
          git config --global user.name "github-actions[bot]"
          git config --global user.email "github-actions[bot]@users.noreply.github.com"
      - name: Python Semantic Release
        uses: python-semantic-release/python-semantic-release@v10.4.1
        env:
          GH_TOKEN: \${{ secrets.PAT_RELEASE || github.token }}
        with:
          github_token: \${{ secrets.PAT_RELEASE || github.token }}
          git_committer_name: "github-actions[bot]"
          git_committer_email: "github-actions[bot]@users.noreply.github.com"
          root_options: -vv --strict
          force: \${{ inputs.release_type != 'auto' && inputs.release_type || '' }}
          prerelease: \${{ inputs.prerelease == true }}
          prerelease_token: rc
`, `    uses: owner/reusable/.github/workflows/release.yml@v1
    secrets: inherit
`)],
      ['job-level uses on another job', validWorkflow().replace('jobs:\n', `jobs:
  reused-release:
    uses: owner/reusable/.github/workflows/release.yml@v1
    secrets: inherit
`)],
    ]

    for (const [label, workflow] of cases) {
      const fixture = createFixture()
      writeFileSync(fixture.workflow, workflow)
      const result = runPolicy(fixture)

      expect(result.status, label).not.toBe(0)
      expect(readReport(fixture).blockers.map((item: { id: string }) => item.id), label).toEqual(
        expect.arrayContaining(['workflow-jobs-local-only']),
      )
    }
  })

  it('rejects noncanonical semantic-release actions in create-release', () => {
    const cases = [
      ['cycjimmy action', 'cycjimmy/semantic-release-action@v4'],
      ['go semantic release action', 'go-semantic-release/action@v1'],
      ['underscore action', 'owner/semantic_release-action@v1'],
      ['uppercase action', 'Python-Semantic-Release/Python-Semantic-Release@v10.4.1'],
      ['wrong psr ref', 'python-semantic-release/python-semantic-release@main'],
    ]

    for (const [label, action] of cases) {
      const fixture = createFixture()
      writeFileSync(
        fixture.workflow,
        validWorkflow().replace('python-semantic-release/python-semantic-release@v10.4.1', action),
      )
      const result = runPolicy(fixture)

      expect(result.status, label).not.toBe(0)
      expect(readReport(fixture).blockers.map((item: { id: string }) => item.id), label).toContain(
        'workflow-create-release-needs-readiness',
      )
    }
  })

  it('rejects create-release steps outside the exact canonical sequence', () => {
    const cases = [
      ['extra benign step before release', validWorkflow().replace('      - name: Python Semantic Release\n', `      - name: Extra benign step
        run: echo ok
      - name: Python Semantic Release
`)],
      ['extra benign step after release', `${validWorkflow().trimEnd()}
      - name: Extra after release
        run: echo ok
`],
      ['semantic-release publish run', validWorkflow().replace('        uses: python-semantic-release/python-semantic-release@v10.4.1', '        run: semantic-release publish')],
      ['gh release create run', validWorkflow().replace('        uses: python-semantic-release/python-semantic-release@v10.4.1', '        run: gh release create v1.2.3')],
      ['softprops action', validWorkflow().replace('python-semantic-release/python-semantic-release@v10.4.1', 'softprops/action-gh-release@v2')],
      ['checkout ref drift', validWorkflow().replace('          token: ${{ secrets.PAT_RELEASE || github.token }}', `          token: \${{ secrets.PAT_RELEASE || github.token }}
          ref: attacker`)],
      ['checkout token drift', validWorkflow().replace('          token: ${{ secrets.PAT_RELEASE || github.token }}', '          token: ${{ secrets.ATTACKER_TOKEN }}')],
      ['extra release action field', validWorkflow().replace('          prerelease_token: rc', `          prerelease_token: rc
          extra: value`)],
      ['tagged release action field', validWorkflow().replace('          prerelease_token: rc', `          prerelease_token: rc
          !!str extra: value`)],
      ['tagged release step field', validWorkflow().replace('        env:\n          GH_TOKEN:', `        !!str extra: value
        env:
          GH_TOKEN:`)],
    ]

    for (const [label, workflow] of cases) {
      const fixture = createFixture()
      writeFileSync(fixture.workflow, workflow)
      const result = runPolicy(fixture)

      expect(result.status, label).not.toBe(0)
      expect(readReport(fixture).blockers.map((item: { id: string }) => item.id), label).toContain(
        'workflow-create-release-needs-readiness',
      )
    }
  }, 15_000)

  it('accepts the current create-release three-step block exactly', () => {
    const fixture = createFixture()
    writeFileSync(fixture.workflow, validWorkflow())
    const result = runPolicy(fixture)

    expect(result.status).not.toBe(0)
    expect(readReport(fixture).blockers.map((item: { id: string }) => item.id)).not.toContain(
      'workflow-create-release-needs-readiness',
    )
  })

  it('rejects workflow trust report path reroutes through environment variables', () => {
    const envCases = [
      ['workflow env', validWorkflow().replace('jobs:\n', `env:\n  AURORA_RELEASE_TRUST_POLICY_REPORT: /tmp/spoof.json\njobs:\n`)],
      ['job env', validWorkflow().replace('  release-readiness:\n', `  release-readiness:\n    env:\n      AURORA_RELEASE_TRUST_POLICY_REPORT: /tmp/spoof.json\n`)],
      ['step env', validWorkflow().replace('      - name: Release trust policy\n', `      - name: Release trust policy\n        env:\n          AURORA_RELEASE_TRUST_POLICY_REPORT: /tmp/spoof.json\n`)],
      ['quoted step env', validWorkflow().replace('      - name: Release trust policy\n', `      - name: Release trust policy\n        env:\n          "AURORA_RELEASE_TRUST_POLICY_REPORT": /tmp/spoof.json\n`)],
      ['escaped step env', validWorkflow().replace('      - name: Release trust policy\n', `      - name: Release trust policy\n        env:\n          "AURORA_RELEASE_TRUST_POLICY_RE\\x50ORT": /tmp/spoof.json\n`)],
      ['tagged step env', validWorkflow().replace('      - name: Release trust policy\n', `      - name: Release trust policy\n        env:\n          !!str AURORA_RELEASE_TRUST_POLICY_REPORT: /tmp/spoof.json\n`)],
      ['inline quoted env', validWorkflow().replace('      - name: Release trust policy\n', `      - name: Release trust policy\n        env: {"AURORA_RELEASE_TRUST_POLICY_REPORT": /tmp/spoof.json}\n`)],
      ['inline escaped env', validWorkflow().replace('      - name: Release trust policy\n', `      - name: Release trust policy\n        env: {"AURORA_RELEASE_TRUST_POLICY_RE\\x50ORT": /tmp/spoof.json}\n`)],
      ['inline tagged env', validWorkflow().replace('      - name: Release trust policy\n', `      - name: Release trust policy\n        env: {!!str AURORA_RELEASE_TRUST_POLICY_REPORT: /tmp/spoof.json}\n`)],
      ['run export', validWorkflow().replace(expectedTrustCommand, `AURORA_RELEASE_TRUST_POLICY_REPORT=/tmp/spoof.json ${expectedTrustCommand}`)],
    ]

    for (const [label, workflow] of envCases) {
      const fixture = createFixture()
      writeFileSync(fixture.workflow, workflow)
      const result = runPolicy(fixture)

      expect(result.status, label).not.toBe(0)
      expect(readReport(fixture).blockers.map((item: { id: string }) => item.id), label).toContain(
        'workflow-trust-report-path-canonical',
      )
    }
  }, 20_000)

  it('rejects workflow and release-readiness shell defaults that can alter trusted commands', () => {
    const defaultsCases = [
      ['workflow defaults', `
name: Release
defaults:
  run:
    shell: bash -c "true" {0}
jobs:
  release-readiness:
    name: Release readiness checks
    runs-on: ubuntu-latest
    timeout-minutes: 45
    steps:
      - name: Release trust policy
        run: ${expectedTrustCommand}
      - name: Upload trust policy report
        if: always()
        uses: actions/upload-artifact@v4
        with:
          name: release-trust-policy
          path: ${expectedTrustReportPath}
          if-no-files-found: error
      - name: Check next semantic version
        run: echo semver
`],
      ['release-readiness defaults', `
name: Release
permissions:
  contents: read
jobs:
  release-readiness:
    defaults:
      run:
        shell: bash -c "true" {0}
    steps:
      - name: Release trust policy
        run: ${expectedTrustCommand}
      - name: Upload trust policy report
        if: always()
        uses: actions/upload-artifact@v4
        with:
          name: release-trust-policy
          path: ${expectedTrustReportPath}
      - name: Check next semantic version
        run: echo semver
`],
    ]

    for (const [label, workflow] of defaultsCases) {
      const fixture = createFixture()
      writeFileSync(fixture.workflow, workflow)
      const result = runPolicy(fixture)

      expect(result.status, label).not.toBe(0)
      expect(readReport(fixture).blockers.map((item: { id: string }) => item.id), label).toContain(
        'workflow-release-readiness-unique-structure',
      )
    }
  })

  it('rejects release-readiness job-level continue-on-error controls', () => {
    const controls = [
      ['canonical false still disallowed at job level', '    continue-on-error: false'],
      ['truthy', '    continue-on-error: true'],
      ['expression', '    continue-on-error: ${{ true }}'],
      ['tagged true value', '    continue-on-error: !!bool true'],
      ['tagged key', '    !!str continue-on-error: true'],
    ]

    for (const [label, controlLine] of controls) {
      const fixture = createFixture()
      writeFileSync(fixture.workflow, `
name: Release
permissions:
  contents: read
jobs:
  release-readiness:
${controlLine}
    steps:
      - name: Release trust policy
        run: ${expectedTrustCommand}
      - name: Upload trust policy report
        if: always()
        uses: actions/upload-artifact@v4
        with:
          name: release-trust-policy
          path: ${expectedTrustReportPath}
      - name: Check next semantic version
        run: echo semver
`)
      const result = runPolicy(fixture)

      expect(result.status, label).not.toBe(0)
      expect(readReport(fixture).blockers.map((item: { id: string }) => item.id), label).toContain(
        'workflow-release-readiness-unique-structure',
      )
    }
  })

  it('rejects release-readiness steps nested under an unrelated job mapping', () => {
    const fixture = createFixture()
    writeFileSync(fixture.workflow, `
name: Release
jobs:
  unrelated:
    release-readiness:
      steps:
        - name: Release trust policy
          run: ${expectedTrustCommand}
        - name: Upload trust policy report
          if: always()
          uses: actions/upload-artifact@v4
          with:
            name: release-trust-policy
            path: ${expectedTrustReportPath}
        - name: Check next semantic version
          run: echo semver
`)
    const result = runPolicy(fixture)

    expect(result.status).not.toBe(0)
    const ids = readReport(fixture).blockers.map((item: { id: string }) => item.id)
    expect(ids).toContain('workflow-trust-gate-before-semver')
    expect(ids).toContain('workflow-trust-report-upload-always')
  })

  it('rejects release-readiness jobs whose steps are nested below another mapping', () => {
    const fixture = createFixture()
    writeFileSync(fixture.workflow, `
name: Release
jobs:
  release-readiness:
    unrelated:
      steps:
        - name: Release trust policy
          run: ${expectedTrustCommand}
        - name: Upload trust policy report
          if: always()
          uses: actions/upload-artifact@v4
          with:
            name: release-trust-policy
            path: ${expectedTrustReportPath}
        - name: Check next semantic version
          run: echo semver
`)
    const result = runPolicy(fixture)

    expect(result.status).not.toBe(0)
    const ids = readReport(fixture).blockers.map((item: { id: string }) => item.id)
    expect(ids).toContain('workflow-trust-gate-before-semver')
    expect(ids).toContain('workflow-trust-report-upload-always')
  })

  it('rejects duplicate top-level jobs keys even when the first jobs mapping is valid', () => {
    const fixture = createFixture()
    writeFileSync(fixture.workflow, `${validWorkflow()}
jobs:
  unrelated:
    steps:
      - name: Duplicate jobs mapping
        run: echo duplicate
`)
    const result = runPolicy(fixture)

    expect(result.status).not.toBe(0)
    expect(readReport(fixture).blockers.map((item: { id: string }) => item.id)).toContain(
      'workflow-release-readiness-unique-structure',
    )
  })

  it('rejects duplicate top-level jobs keys with inline mapping values', () => {
    const duplicateForms = [
      'jobs: {}',
      '"jo\\u0062s": {}',
      '!!str jobs: {}',
      '!<tag:yaml.org,2002:str> jobs: {}',
    ]

    for (const duplicateLine of duplicateForms) {
      const fixture = createFixture()
      writeFileSync(fixture.workflow, `${validWorkflow()}
${duplicateLine}
`)
      const result = runPolicy(fixture)

      expect(result.status, duplicateLine).not.toBe(0)
      expect(
        readReport(fixture).blockers.map((item: { id: string }) => item.id),
        duplicateLine,
      ).toContain('workflow-release-readiness-unique-structure')
    }
  })

  it('preserves ordinary block-scalar commands that look like unsupported YAML keys', () => {
    const fixture = createFixture()
    writeFileSync(fixture.workflow, `
name: Release
permissions:
  contents: read
jobs:
  release-readiness:
    name: Release readiness checks
    runs-on: ubuntu-latest
    timeout-minutes: 45
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0
      - name: Set up Python
        uses: actions/setup-python@v5
        with:
          python-version: "3.11.11"
      - name: Install uv
        uses: astral-sh/setup-uv@v5
      - name: Set up pnpm
        uses: pnpm/action-setup@v4
      - name: Set up Node
        uses: actions/setup-node@v4
        with:
          node-version: 24
          cache: pnpm
      - name: Release trust policy
        run: |
          ${expectedTrustCommand}
          ! echo shell history expansion is command text
          ? echo shell ternary-ish command text
          <<: shell heredoc-ish command text
      - name: Upload trust policy report
        if: always()
        uses: actions/upload-artifact@v4
        with:
          name: release-trust-policy
          path: ${expectedTrustReportPath}
      - name: Check next semantic version
        run: echo semver
`)
    const result = runPolicy(fixture)

    expect(readReport(fixture).blockers.map((item: { id: string }) => item.id)).not.toContain(
      'workflow-release-readiness-unique-structure',
    )
    expect(result.status).not.toBe(0)
  })

  it('rejects duplicate direct release-readiness job IDs even when the first job is valid', () => {
    const fixture = createFixture()
    writeFileSync(fixture.workflow, `
name: Release
jobs:
  release-readiness:
    steps:
      - name: Release trust policy
        run: ${expectedTrustCommand}
      - name: Upload trust policy report
        if: always()
        uses: actions/upload-artifact@v4
        with:
          name: release-trust-policy
          path: ${expectedTrustReportPath}
      - name: Check next semantic version
        run: echo semver
  release-readiness:
    steps:
      - name: Shadow duplicate job
        run: echo duplicate
`)
    const result = runPolicy(fixture)

    expect(result.status).not.toBe(0)
    expect(readReport(fixture).blockers.map((item: { id: string }) => item.id)).toContain(
      'workflow-release-readiness-unique-structure',
    )
  })

  it('rejects duplicate direct release-readiness job IDs with inline and quoted forms', () => {
    const duplicateForms = [
      '  release-readiness: {}',
      '  "release-readiness": {}',
      '  "release\\u002dreadiness": {}',
      "  'release-readiness': {}",
      '  !!str release-readiness: {}',
      '  !<tag:yaml.org,2002:str> release-readiness: {}',
    ]

    for (const duplicateLine of duplicateForms) {
      const fixture = createFixture()
      writeFileSync(fixture.workflow, `
name: Release
jobs:
  release-readiness:
    steps:
      - name: Release trust policy
        run: ${expectedTrustCommand}
      - name: Upload trust policy report
        if: always()
        uses: actions/upload-artifact@v4
        with:
          name: release-trust-policy
          path: ${expectedTrustReportPath}
      - name: Check next semantic version
        run: echo semver
${duplicateLine}
`)
      const result = runPolicy(fixture)

      expect(result.status, duplicateLine).not.toBe(0)
      expect(
        readReport(fixture).blockers.map((item: { id: string }) => item.id),
        duplicateLine,
      ).toContain('workflow-release-readiness-unique-structure')
    }
  }, 15_000)

  it('rejects duplicate direct steps keys under release-readiness', () => {
    const fixture = createFixture()
    writeFileSync(fixture.workflow, `
name: Release
jobs:
  release-readiness:
    steps:
      - name: Release trust policy
        run: ${expectedTrustCommand}
      - name: Upload trust policy report
        if: always()
        uses: actions/upload-artifact@v4
        with:
          name: release-trust-policy
          path: ${expectedTrustReportPath}
      - name: Check next semantic version
        run: echo semver
    steps:
      - name: Shadow duplicate steps
        run: echo duplicate
`)
    const result = runPolicy(fixture)

    expect(result.status).not.toBe(0)
    expect(readReport(fixture).blockers.map((item: { id: string }) => item.id)).toContain(
      'workflow-release-readiness-unique-structure',
    )
  })

  it('rejects duplicate direct steps keys with inline sequence and quoted forms', () => {
    const duplicateForms = [
      '    steps: []',
      '    "steps": []',
      '    "ste\\x70s": []',
      "    'steps': []",
      '    !!str steps: []',
      '    !<tag:yaml.org,2002:str> steps: []',
    ]

    for (const duplicateLine of duplicateForms) {
      const fixture = createFixture()
      writeFileSync(fixture.workflow, `
name: Release
jobs:
  release-readiness:
    steps:
      - name: Release trust policy
        run: ${expectedTrustCommand}
      - name: Upload trust policy report
        if: always()
        uses: actions/upload-artifact@v4
        with:
          name: release-trust-policy
          path: ${expectedTrustReportPath}
      - name: Check next semantic version
        run: echo semver
${duplicateLine}
`)
      const result = runPolicy(fixture)

      expect(result.status, duplicateLine).not.toBe(0)
      expect(
        readReport(fixture).blockers.map((item: { id: string }) => item.id),
        duplicateLine,
      ).toContain('workflow-release-readiness-unique-structure')
    }
  }, 15_000)

  it('rejects workflow key structures that use aliases, anchors, merge keys, or complex keys', () => {
    const hostileWorkflows = [
      ['merge key', `${validWorkflow()}
<<: *shadowJobs
`],
      ['anchor value', `
name: Release
jobs:
  release-readiness: &releaseReadiness
    steps:
      - name: Release trust policy
        run: ${expectedTrustCommand}
`],
      ['alias key', `
name: Release
jobs:
  *releaseReadiness:
    steps: []
`],
      ['complex key', `
name: Release
jobs:
  ? release-readiness
  : steps: []
`],
    ]

    for (const [label, workflow] of hostileWorkflows) {
      const fixture = createFixture()
      writeFileSync(fixture.workflow, workflow)
      const result = runPolicy(fixture)

      expect(result.status, label).not.toBe(0)
      expect(
        readReport(fixture).blockers.map((item: { id: string }) => item.id),
        label,
      ).toContain('workflow-release-readiness-unique-structure')
    }
  }, 15_000)

  it('rejects multiline quoted keys that could obscure release-readiness or steps', () => {
    const hostileWorkflows = [
      ['release-readiness multiline key', `
name: Release
jobs:
  "release
  -readiness":
    steps: []
`],
      ['steps multiline key', `
name: Release
jobs:
  release-readiness:
    "ste
    ps": []
`],
    ]

    for (const [label, workflow] of hostileWorkflows) {
      const fixture = createFixture()
      writeFileSync(fixture.workflow, workflow)
      const result = runPolicy(fixture)

      expect(result.status, label).not.toBe(0)
      expect(
        readReport(fixture).blockers.map((item: { id: string }) => item.id),
        label,
      ).toContain('workflow-release-readiness-unique-structure')
    }
  })

  it('rejects duplicate direct step fields that could spoof release trust commands', () => {
    const duplicateCases = [
      ['run', `
name: Release
jobs:
  release-readiness:
    steps:
      - name: Release trust policy
        run: ${expectedTrustCommand}
        run: echo malicious
      - name: Upload trust policy report
        if: always()
        uses: actions/upload-artifact@v4
        with:
          name: release-trust-policy
          path: ${expectedTrustReportPath}
      - name: Check next semantic version
        run: echo semver
`],
      ['uses', `
name: Release
jobs:
  release-readiness:
    steps:
      - name: Release trust policy
        run: ${expectedTrustCommand}
      - name: Upload trust policy report
        if: always()
        uses: actions/upload-artifact@v4
        uses: actions/download-artifact@v4
        with:
          name: release-trust-policy
          path: ${expectedTrustReportPath}
      - name: Check next semantic version
        run: echo semver
`],
      ['if', `
name: Release
jobs:
  release-readiness:
    steps:
      - name: Release trust policy
        run: ${expectedTrustCommand}
      - name: Upload trust policy report
        if: always()
        if: success()
        uses: actions/upload-artifact@v4
        with:
          name: release-trust-policy
          path: ${expectedTrustReportPath}
      - name: Check next semantic version
        run: echo semver
`],
      ['with', `
name: Release
jobs:
  release-readiness:
    steps:
      - name: Release trust policy
        run: ${expectedTrustCommand}
      - name: Upload trust policy report
        if: always()
        uses: actions/upload-artifact@v4
        with:
          name: release-trust-policy
          path: ${expectedTrustReportPath}
        with:
          name: malicious
          path: reports/malicious.json
      - name: Check next semantic version
        run: echo semver
`],
    ]

    for (const [label, workflow] of duplicateCases) {
      const fixture = createFixture()
      writeFileSync(fixture.workflow, workflow)
      const result = runPolicy(fixture)

      expect(result.status, label).not.toBe(0)
      expect(
        readReport(fixture).blockers.map((item: { id: string }) => item.id),
        label,
      ).toContain('workflow-release-readiness-unique-step-keys')
    }
  })

  it('rejects explicit YAML keys for direct step fields', () => {
    const explicitKeyCases = [
      ['run', '? run\n        : echo bypass'],
      ['uses', '? uses\n        : actions/download-artifact@v4'],
      ['if', '? if\n        : false'],
      ['with', '? with\n        : { name: malicious }'],
    ]

    for (const [label, explicitKey] of explicitKeyCases) {
      const fixture = createFixture()
      writeFileSync(fixture.workflow, `
name: Release
jobs:
  release-readiness:
    steps:
      - name: Release trust policy
        run: ${expectedTrustCommand}
      - name: Upload trust policy report
        if: always()
        uses: actions/upload-artifact@v4
        with:
          name: release-trust-policy
          path: ${expectedTrustReportPath}
        ${explicitKey}
      - name: Check next semantic version
        run: echo semver
`)
      const result = runPolicy(fixture)

      expect(result.status, label).not.toBe(0)
      expect(
        readReport(fixture).blockers.map((item: { id: string }) => item.id),
        label,
      ).toContain('workflow-release-readiness-unique-step-keys')
    }
  })

  it('rejects merge, anchor, alias, and tagged YAML keys in direct step fields', () => {
    const hostileLines = [
      ['merge', '        <<: *defaults'],
      ['anchor key', '        &run: echo bypass'],
      ['alias key', '        *run: echo bypass'],
      ['tagged key', '        !!str run: echo bypass'],
    ]

    for (const [label, hostileLine] of hostileLines) {
      const fixture = createFixture()
      writeFileSync(fixture.workflow, `
name: Release
jobs:
  release-readiness:
    steps:
      - name: Release trust policy
        run: ${expectedTrustCommand}
${hostileLine}
      - name: Upload trust policy report
        if: always()
        uses: actions/upload-artifact@v4
        with:
          name: release-trust-policy
          path: ${expectedTrustReportPath}
      - name: Check next semantic version
        run: echo semver
`)
      const result = runPolicy(fixture)

      expect(result.status, label).not.toBe(0)
      expect(
        readReport(fixture).blockers.map((item: { id: string }) => item.id),
        label,
      ).toContain('workflow-release-readiness-unique-step-keys')
    }
  })

  it('rejects duplicate artifact upload fields inside with mappings', () => {
    const duplicateCases = [
      ['name', `
name: Release
jobs:
  release-readiness:
    steps:
      - name: Release trust policy
        run: ${expectedTrustCommand}
      - name: Upload trust policy report
        if: always()
        uses: actions/upload-artifact@v4
        with:
          name: release-trust-policy
          name: malicious
          path: ${expectedTrustReportPath}
      - name: Check next semantic version
        run: echo semver
`],
      ['path', `
name: Release
jobs:
  release-readiness:
    steps:
      - name: Release trust policy
        run: ${expectedTrustCommand}
      - name: Upload trust policy report
        if: always()
        uses: actions/upload-artifact@v4
        with:
          name: release-trust-policy
          path: ${expectedTrustReportPath}
          path: reports/malicious.json
      - name: Check next semantic version
        run: echo semver
`],
      ['escaped path', `
name: Release
jobs:
  release-readiness:
    steps:
      - name: Release trust policy
        run: ${expectedTrustCommand}
      - name: Upload trust policy report
        if: always()
        uses: actions/upload-artifact@v4
        with:
          path: ${expectedTrustReportPath}
          "pa\\x74h": reports/malicious.json
      - name: Check next semantic version
        run: echo semver
`],
      ['tagged path', `
name: Release
jobs:
  release-readiness:
    steps:
      - name: Release trust policy
        run: ${expectedTrustCommand}
      - name: Upload trust policy report
        if: always()
        uses: actions/upload-artifact@v4
        with:
          path: ${expectedTrustReportPath}
          !!str path: reports/malicious.json
      - name: Check next semantic version
        run: echo semver
`],
    ]

    for (const [label, workflow] of duplicateCases) {
      const fixture = createFixture()
      writeFileSync(fixture.workflow, workflow)
      const result = runPolicy(fixture)

      expect(result.status, label).not.toBe(0)
      expect(
        readReport(fixture).blockers.map((item: { id: string }) => item.id),
        label,
      ).toContain('workflow-release-readiness-unique-step-keys')
    }
  })

  it('rejects explicit YAML keys inside artifact upload with mappings', () => {
    const explicitKeyCases = [
      ['name', '? name\n          : malicious'],
      ['path', '? path\n          : reports/malicious.json'],
    ]

    for (const [label, explicitKey] of explicitKeyCases) {
      const fixture = createFixture()
      writeFileSync(fixture.workflow, `
name: Release
jobs:
  release-readiness:
    steps:
      - name: Release trust policy
        run: ${expectedTrustCommand}
      - name: Upload trust policy report
        if: always()
        uses: actions/upload-artifact@v4
        with:
          name: release-trust-policy
          path: ${expectedTrustReportPath}
          ${explicitKey}
      - name: Check next semantic version
        run: echo semver
`)
      const result = runPolicy(fixture)

      expect(result.status, label).not.toBe(0)
      expect(
        readReport(fixture).blockers.map((item: { id: string }) => item.id),
        label,
      ).toContain('workflow-release-readiness-unique-step-keys')
    }
  }, 15_000)

  it('rejects merge, anchor, alias, and tagged YAML keys inside artifact upload with mappings', () => {
    const hostileLines = [
      ['merge', '          <<: *defaults'],
      ['anchor key', '          &path: reports/malicious.json'],
      ['alias key', '          *path: reports/malicious.json'],
      ['tagged key', '          !!str path: reports/malicious.json'],
    ]

    for (const [label, hostileLine] of hostileLines) {
      const fixture = createFixture()
      writeFileSync(fixture.workflow, `
name: Release
jobs:
  release-readiness:
    steps:
      - name: Release trust policy
        run: ${expectedTrustCommand}
      - name: Upload trust policy report
        if: always()
        uses: actions/upload-artifact@v4
        with:
          name: release-trust-policy
          path: ${expectedTrustReportPath}
${hostileLine}
      - name: Check next semantic version
        run: echo semver
`)
      const result = runPolicy(fixture)

      expect(result.status, label).not.toBe(0)
      expect(
        readReport(fixture).blockers.map((item: { id: string }) => item.id),
        label,
      ).toContain('workflow-release-readiness-unique-step-keys')
    }
  }, 15_000)

  it('rejects reordered release-readiness steps after semantic versioning', () => {
    const fixture = createFixture()
    writeFileSync(fixture.workflow, `
name: Release
jobs:
  release-readiness:
    steps:
      - name: Check next semantic version
        run: echo semver
      - name: Release trust policy
        run: ${expectedTrustCommand}
      - name: Upload trust policy report
        if: always()
        uses: actions/upload-artifact@v4
        with:
          name: release-trust-policy
          path: ${expectedTrustReportPath}
`)
    const result = runPolicy(fixture)

    expect(result.status).not.toBe(0)
    const ids = readReport(fixture).blockers.map((item: { id: string }) => item.id)
    expect(ids).toContain('workflow-trust-gate-before-semver')
    expect(ids).toContain('workflow-trust-report-upload-always')
  })

  it('rejects low-entropy updater public keys while accepting the minisign-shaped fixture', () => {
    const fixture = createFixture()
    writeJson(fixture.config, {
      ...productionTauriConfig(),
      plugins: {
        updater: {
          pubkey: 'A'.repeat(88),
          endpoints: ['https://releases.aurora.dev/latest/{{target}}/{{arch}}/{{current_version}}.json'],
        },
      },
    })
    const blocked = runPolicy(fixture)

    expect(blocked.status).not.toBe(0)
    expect(readReport(fixture).blockers.map((item: { id: string }) => item.id)).toContain(
      'updater-public-key-plausible',
    )

    writeJson(fixture.config, productionTauriConfig())
    const accepted = runPolicy(fixture)
    expect(readReport(fixture).blockers.map((item: { id: string }) => item.id)).not.toContain(
      'updater-public-key-plausible',
    )
    expect(accepted.status).not.toBe(0)
  })

  it('rejects minisign-shaped updater keys with zero placeholder key material', () => {
    const fixture = createFixture()
    writeJson(fixture.config, {
      ...productionTauriConfig(),
      plugins: {
        updater: {
          pubkey: tauriUpdaterPubkeyFromBytes(Buffer.concat([Buffer.from('Ed'), Buffer.alloc(40)])),
          endpoints: ['https://releases.aurora.dev/latest/{{target}}/{{arch}}/{{current_version}}.json'],
        },
      },
    })
    const blocked = runPolicy(fixture)

    expect(blocked.status).not.toBe(0)
    expect(readReport(fixture).blockers.map((item: { id: string }) => item.id)).toContain(
      'updater-public-key-plausible',
    )
  })

  it('rejects minisign-shaped updater keys with repeated short-pattern key material', () => {
    const fixture = createFixture()
    const repeatedPatternKey = Buffer.from(Array.from({ length: 42 }, (_value, index) => {
      if (index === 0) return 'E'.charCodeAt(0)
      if (index === 1) return 'd'.charCodeAt(0)
      return [0x41, 0x42, 0x43][(index - 2) % 3]
    }))
    writeJson(fixture.config, {
      ...productionTauriConfig(),
      plugins: {
        updater: {
          pubkey: tauriUpdaterPubkeyFromBytes(repeatedPatternKey),
          endpoints: ['https://releases.aurora.dev/latest/{{target}}/{{arch}}/{{current_version}}.json'],
        },
      },
    })
    const blocked = runPolicy(fixture)

    expect(blocked.status).not.toBe(0)
    expect(readReport(fixture).blockers.map((item: { id: string }) => item.id)).toContain(
      'updater-public-key-plausible',
    )

    writeJson(fixture.config, productionTauriConfig())
    const accepted = runPolicy(fixture)
    expect(readReport(fixture).blockers.map((item: { id: string }) => item.id)).not.toContain(
      'updater-public-key-plausible',
    )
    expect(accepted.status).not.toBe(0)
  })

  it('rejects minisign-shaped updater keys with period 9 and 16 key material', () => {
    for (const period of [9, 16]) {
      const fixture = createFixture()
      writeJson(fixture.config, {
        ...productionTauriConfig(),
        plugins: {
          updater: {
            pubkey: periodicTauriUpdaterPubkey(period),
            endpoints: ['https://releases.aurora.dev/latest/{{target}}/{{arch}}/{{current_version}}.json'],
          },
        },
      })
      const blocked = runPolicy(fixture)

      expect(blocked.status, `period ${period}`).not.toBe(0)
      expect(
        readReport(fixture).blockers.map((item: { id: string }) => item.id),
        `period ${period}`,
      ).toContain('updater-public-key-plausible')
    }

    const acceptedFixture = createFixture()
    const accepted = runPolicy(acceptedFixture)
    expect(readReport(acceptedFixture).blockers.map((item: { id: string }) => item.id)).not.toContain(
      'updater-public-key-plausible',
    )
    expect(accepted.status).not.toBe(0)
  })

  it('emits a redacted report for malformed hostile inputs', () => {
    const fixture = createFixture()
    const secret = '-----BEGIN PRIVATE KEY-----\\n' + 'A'.repeat(120) + '\\n-----END PRIVATE KEY-----'
    writeFileSync(fixture.config, `{ "plugins": { "updater": { "pubkey": "${secret}", } }`)
    writeFileSync(fixture.androidPreflight, `const password = "${secret}"\n`)
    const result = runPolicy(fixture)

    expect(result.status).not.toBe(0)
    const rawReport = readFileSync(fixture.report, 'utf8')
    expect(rawReport).not.toContain(secret)
    expect(rawReport).not.toContain('PRIVATE KEY')
    expect(rawReport).not.toContain(fixture.root)
    expect(JSON.parse(rawReport)).toMatchObject({
      status: 'blocked',
      claimBoundary: 'static-policy-only',
      secretsRedacted: true,
    })
  })

  it('has valid JavaScript syntax', () => {
    execFileSync(process.execPath, ['--check', script], { cwd: packageRoot })
  })
})

function productionTauriConfig() {
  return {
    bundle: { createUpdaterArtifacts: true },
    plugins: {
      updater: {
        pubkey: realisticTauriUpdaterPubkey,
        endpoints: ['https://releases.aurora.dev/latest/{{target}}/{{arch}}/{{current_version}}.json'],
      },
    },
  }
}

function desktopOverlay() {
  return {
    app: {
      security: {
        capabilities: ['aurora-main', 'aurora-overlay', 'aurora-desktop-updater'],
      },
    },
  }
}

function validWorkflow() {
  return `
name: Release
permissions:
  contents: read
jobs:
  release-readiness:
    name: Release readiness checks
    runs-on: ubuntu-latest
    timeout-minutes: 45
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0
      - name: Set up Python
        uses: actions/setup-python@v5
        with:
          python-version: "3.11.11"
      - name: Install uv
        uses: astral-sh/setup-uv@v5
      - name: Set up pnpm
        uses: pnpm/action-setup@v4
      - name: Set up Node
        uses: actions/setup-node@v4
        with:
          node-version: 24
          cache: pnpm
      - name: Install Python release dependencies
        run: uv sync --extra dev --extra build
      - name: Install workspace dependencies
        run: pnpm install --frozen-lockfile
      - name: Release dependency inventory
        run: ${expectedDependencyInventoryCommand}
      - name: Upload release dependency inventory report
        if: always()
        uses: actions/upload-artifact@v4
        with:
          name: release-dependency-inventory
          path: ${expectedDependencyInventoryReportPath}
          if-no-files-found: error
      - name: Release trust policy
        if: always()
        run: |
          ${expectedTrustCommand}
      - name: Upload trust policy report
        if: always()
        uses: actions/upload-artifact@v4
        with:
          name: release-trust-policy
          path: ${expectedTrustReportPath}
          if-no-files-found: error
      - name: Check next semantic version
        run: ${expectedSemanticReleaseCommand}
  create-release:
    name: Create semantic release
    runs-on: ubuntu-latest
    needs: release-readiness
    if: success() && inputs.dry_run == false
    timeout-minutes: 20
    permissions:
      contents: write
      id-token: write
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0
          token: \${{ secrets.PAT_RELEASE || github.token }}
      - name: Configure Git
        run: |
          git config --global user.name "github-actions[bot]"
          git config --global user.email "github-actions[bot]@users.noreply.github.com"
      - name: Python Semantic Release
        uses: python-semantic-release/python-semantic-release@v10.4.1
        env:
          GH_TOKEN: \${{ secrets.PAT_RELEASE || github.token }}
        with:
          github_token: \${{ secrets.PAT_RELEASE || github.token }}
          git_committer_name: "github-actions[bot]"
          git_committer_email: "github-actions[bot]@users.noreply.github.com"
          root_options: -vv --strict
          force: \${{ inputs.release_type != 'auto' && inputs.release_type || '' }}
          prerelease: \${{ inputs.prerelease == true }}
          prerelease_token: rc
`
}

function validDependencyInventoryReport(): any {
  const ecosystems = ['cargo', 'npm', 'phase4-native-voice', 'python']
  const inventory = ecosystems.map((ecosystem, index) => ({
    id: `${ecosystem}:fixture:${index + 1}.0.0`,
    ecosystem,
    scope: 'release-static',
    name: `${ecosystem}-fixture`,
    version: `${index + 1}.0.0`,
    source: 'fixture-metadata',
    sourceRef: 'release fixture metadata',
    hash: ecosystem === 'npm'
      ? `sha512:${String(index + 1).repeat(128)}`
      : `sha256:${String(index + 1).repeat(64)}`,
    license: {
      id: 'MIT',
      evidence: 'release fixture metadata',
      evidenceHash: `sha256:${String(index + 5).repeat(64)}`,
    },
    disposition: 'allowed',
  }))
  return {
    schema: 'aurora.release-dependency-inventory.v1',
    generatedAt: '2026-08-12T00:00:00.000Z',
    source: {
      commit: currentSourceCommit,
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
    status: 'passed',
    releaseBlocked: false,
    secretsRedacted: true,
    tools: [
      { name: 'cargo', available: true, version: 'cargo 1.88.0' },
      { name: 'pnpm', available: true, version: '10.25.0' },
      { name: 'uv', available: true, version: 'uv 0.8.0' },
    ],
    inputs: [
      { path: 'pnpm-lock.yaml', sha256: 'a'.repeat(64) },
    ],
    summary: {
      totalEntries: inventory.length,
      ecosystems: Object.fromEntries(ecosystems.map((ecosystem) => [ecosystem, 1])),
      dispositions: { allowed: inventory.length },
    },
    blockers: [],
    inventory,
  }
}

function sourceWith(content: string) {
  return `#!/usr/bin/env node\n${content}\n`
}

function tauriUpdaterPubkeyFromBytes(value: Buffer) {
  const minisignLine = value.toString('base64')
  return Buffer.from(`untrusted comment: minisign public key\n${minisignLine}\n`, 'utf8').toString('base64')
}

function periodicTauriUpdaterPubkey(period: number) {
  const keyId = Buffer.from([0x03, 0x11, 0x29, 0x4f, 0x83, 0xad, 0xd3, 0xef])
  const pattern = Buffer.from(Array.from({ length: period }, (_value, index) => (index * 37 + 11) & 0xff))
  const keyMaterial = Buffer.from(Array.from({ length: 32 }, (_value, index) => pattern[index % period]))
  return tauriUpdaterPubkeyFromBytes(Buffer.concat([Buffer.from('Ed'), keyId, keyMaterial]))
}

function writeJson(path: string, value: unknown) {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`)
}
