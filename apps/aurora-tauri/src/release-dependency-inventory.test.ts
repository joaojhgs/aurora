// @vitest-environment node

import { spawnSync } from 'node:child_process'
import {
  mkdirSync,
  mkdtempSync,
  existsSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const repoRoot = resolve(packageRoot, '..', '..')
const script = join(repoRoot, 'scripts', 'generate_release_dependency_inventory.mjs')
const expectedPackageScriptName = 'verify:release-dependency-inventory'
const expectedPackageScriptCommand = 'node ../../scripts/generate_release_dependency_inventory.mjs'
const expectedWorkflowCommand = 'pnpm --dir apps/aurora-tauri run verify:release-dependency-inventory'
const expectedReportPath = 'apps/aurora-tauri/reports/release-dependency-inventory.json'

interface Fixture {
  root: string
  packageJson: string
  rootPackageJson: string
  pnpmLock: string
  pyproject: string
  uvLock: string
  cargoManifest: string
  cargoLock: string
  cargoMetadata: string
  pnpmLicenses: string
  uvCyclonedx: string
  pythonMetadata: string
  phase4Manifest: string
  report: string
}

function createFixture(): Fixture {
  const root = mkdtempSync(join(tmpdir(), 'aurora-release-dependency-inventory-'))
  const srcTauri = join(root, 'apps', 'aurora-tauri', 'src-tauri')
  const scripts = join(root, 'scripts')
  const tools = join(root, 'tools', 'voice-runtime')
  mkdirSync(srcTauri, { recursive: true })
  mkdirSync(scripts, { recursive: true })
  mkdirSync(tools, { recursive: true })
  mkdirSync(join(root, 'apps', 'aurora-tauri', 'reports'), { recursive: true })

  const fixture: Fixture = {
    root,
    packageJson: join(root, 'apps', 'aurora-tauri', 'package.json'),
    rootPackageJson: join(root, 'package.json'),
    pnpmLock: join(root, 'pnpm-lock.yaml'),
    pyproject: join(root, 'pyproject.toml'),
    uvLock: join(root, 'uv.lock'),
    cargoManifest: join(srcTauri, 'Cargo.toml'),
    cargoLock: join(srcTauri, 'Cargo.lock'),
    cargoMetadata: join(srcTauri, 'cargo-metadata.json'),
    pnpmLicenses: join(root, 'pnpm-licenses.json'),
    uvCyclonedx: join(root, 'uv-cyclonedx.json'),
    pythonMetadata: join(root, 'python-metadata.json'),
    phase4Manifest: join(tools, 'phase4_manifest.json'),
    report: join(root, 'apps', 'aurora-tauri', 'reports', 'release-dependency-inventory.json'),
  }

  writeJson(fixture.packageJson, {
    name: '@aurora/tauri-ui',
    private: true,
    license: 'MIT',
    scripts: { [expectedPackageScriptName]: expectedPackageScriptCommand },
    dependencies: {
      '@tauri-apps/api': '^2.9.0',
      react: '^19',
    },
    devDependencies: {
      vitest: '^4.0.16',
    },
  })
  writeJson(fixture.rootPackageJson, {
    name: 'aurora-workspace',
    private: true,
    packageManager: 'pnpm@10.25.0',
  })
  writeFileSync(fixture.pnpmLock, `
lockfileVersion: '9.0'

importers:

  apps/aurora-tauri:
    dependencies:
      '@tauri-apps/api':
        specifier: ^2.9.0
        version: 2.11.1
      react:
        specifier: ^19
        version: 19.2.7
    devDependencies:
      vitest:
        specifier: ^4.0.16
        version: 4.1.9(@types/node@24.13.2)
`, 'utf8')
  writeFileSync(fixture.pyproject, `
[project]
name = "aurora"
version = "1.0.0"
license = {file = "LICENSE"}
dependencies = ["click>=8.1.0"]
`, 'utf8')
  writeFileSync(fixture.uvLock, `
version = 1
revision = 3
requires-python = ">=3.10, <3.12"

[[package]]
name = "click"
version = "8.3.1"
source = { registry = "https://pypi.org/simple" }
sdist = { hash = "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" }
`, 'utf8')
  writeFileSync(fixture.cargoManifest, `
[package]
name = "aurora-tauri"
version = "0.1.0"
license = "MIT"
`, 'utf8')
  writeFileSync(fixture.cargoLock, `
version = 4

[[package]]
name = "aurora-tauri"
version = "0.1.0"

[[package]]
name = "serde"
version = "1.0.228"
source = "registry+https://github.com/rust-lang/crates.io-index"
checksum = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
`, 'utf8')
  writeJson(fixture.cargoMetadata, {
    packages: [
      {
        name: 'aurora-tauri',
        version: '0.1.0',
        source: null,
        license: 'MIT',
        manifest_path: fixture.cargoManifest,
      },
      {
        name: 'serde',
        version: '1.0.228',
        source: 'registry+https://github.com/rust-lang/crates.io-index',
        license: 'MIT OR Apache-2.0',
        manifest_path: join(fixture.root, 'cargo-registry', 'serde', 'Cargo.toml'),
      },
    ],
  })
  writeJson(fixture.pnpmLicenses, {
    MIT: [
      {
        name: '@tauri-apps/api',
        versions: ['2.11.1'],
        paths: [join(fixture.root, 'node_modules/.pnpm/@tauri-apps+api@2.11.1/node_modules/@tauri-apps/api')],
        license: 'MIT',
      },
      {
        name: 'react-transitive-helper',
        versions: ['1.2.3'],
        paths: [join(fixture.root, 'node_modules/.pnpm/react-transitive-helper@1.2.3/node_modules/react-transitive-helper')],
        license: 'MIT',
      },
    ],
    'GPL-3.0-only': [
      {
        name: 'blocked-npm-package',
        versions: ['9.9.9'],
        paths: [join(fixture.root, 'node_modules/.pnpm/blocked-npm-package@9.9.9/node_modules/blocked-npm-package')],
        license: 'GPL-3.0-only',
      },
    ],
  })
  writeJson(fixture.uvCyclonedx, {
    bomFormat: 'CycloneDX',
    specVersion: '1.5',
    components: [
      {
        type: 'library',
        'bom-ref': 'click-1@8.3.1',
        name: 'click',
        version: '8.3.1',
        purl: 'pkg:pypi/click@8.3.1',
      },
      {
        type: 'library',
        'bom-ref': 'transitive-python-2@4.5.6',
        name: 'transitive-python',
        version: '4.5.6',
        purl: 'pkg:pypi/transitive-python@4.5.6',
      },
      {
        type: 'library',
        'bom-ref': 'unknown-python-3@7.8.9',
        name: 'unknown-python',
        version: '7.8.9',
        purl: 'pkg:pypi/unknown-python@7.8.9',
      },
    ],
  })
  writeJson(fixture.pythonMetadata, [
    {
      name: 'click',
      version: '8.3.1',
      license: 'BSD-3-Clause',
    },
    {
      name: 'transitive-python',
      version: '4.5.6',
      license: 'Apache-2.0',
    },
  ])
  writeJson(fixture.phase4Manifest, {
    schema_version: 1,
    artifacts: [
      {
        id: 'phase4-selected-runtime',
        kind: 'source',
        role: 'native-speech-runtime',
        status: 'selected',
        version: 'v1',
        sha256: 'cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
        license: {
          spdx: 'Apache-2.0',
          evidence: 'sources/runtime/LICENSE',
          evidence_sha256: 'dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd',
          disposition: 'allowed',
        },
      },
      {
        id: 'phase4-blocked-voice',
        kind: 'source',
        role: 'blocked-voice-dependency',
        status: 'blocked',
        version: 'v2',
        sha256: 'eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',
        license: {
          spdx: 'MIT',
          evidence: 'sources/blocked/LICENSE',
          evidence_sha256: 'ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff',
          disposition: 'blocked',
        },
      },
    ],
  })
  return fixture
}

function runInventory(fixture: Fixture, extraArgs: string[] = []) {
  return spawnSync(process.execPath, [
    script,
    '--source-commit', currentHead(),
    '--package-json', fixture.packageJson,
    '--root-package-json', fixture.rootPackageJson,
    '--pnpm-lock', fixture.pnpmLock,
    '--pyproject', fixture.pyproject,
    '--uv-lock', fixture.uvLock,
    '--cargo-manifest', fixture.cargoManifest,
    '--cargo-lock', fixture.cargoLock,
    '--cargo-metadata-json', fixture.cargoMetadata,
    '--pnpm-licenses-json', fixture.pnpmLicenses,
    '--uv-cyclonedx-json', fixture.uvCyclonedx,
    '--python-metadata-json', fixture.pythonMetadata,
    '--phase4-manifest', fixture.phase4Manifest,
    '--report', fixture.report,
    ...extraArgs,
  ], {
    cwd: repoRoot,
    encoding: 'utf8',
  })
}

function readReport(fixture: Fixture) {
  return JSON.parse(readFileSync(fixture.report, 'utf8'))
}

describe('release dependency inventory gate', () => {
  it('produces a redacted static metadata report and blocks unknown or blocked license dispositions', () => {
    const fixture = createFixture()
    const result = runInventory(fixture)

    expect(result.status).not.toBe(0)
    const report = readReport(fixture)
    expect(report).toMatchObject({
      schema: 'aurora.release-dependency-inventory.v1',
      status: 'blocked',
      releaseBlocked: true,
      secretsRedacted: true,
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
    })
    expect(report.source.commit).toBe(currentHead())
    expect(report.blockers.map((item: { id: string }) => item.id)).toEqual(expect.arrayContaining([
      'unknown-license-metadata',
      'blocked-license-disposition',
    ]))
    expect(report.inventory).toEqual(expect.arrayContaining([
      expect.objectContaining({
        ecosystem: 'npm',
        scope: 'production-transitive',
        name: '@tauri-apps/api',
        license: expect.objectContaining({ id: 'MIT' }),
        disposition: 'allowed',
      }),
      expect.objectContaining({
        ecosystem: 'npm',
        scope: 'production-transitive',
        name: 'react-transitive-helper',
        license: expect.objectContaining({ id: 'MIT' }),
        disposition: 'allowed',
      }),
      expect.objectContaining({
        ecosystem: 'npm',
        name: 'blocked-npm-package',
        license: expect.objectContaining({ id: 'GPL-3.0-only' }),
        disposition: 'blocked',
      }),
      expect.objectContaining({
        ecosystem: 'python',
        scope: 'all-extras-all-groups',
        name: 'transitive-python',
        license: expect.objectContaining({ id: 'Apache-2.0' }),
        disposition: 'allowed',
      }),
      expect.objectContaining({
        ecosystem: 'python',
        name: 'unknown-python',
        license: expect.objectContaining({ id: 'UNKNOWN' }),
        disposition: 'blocked',
      }),
      expect.objectContaining({
        ecosystem: 'cargo',
        name: 'serde',
        license: expect.objectContaining({ id: 'MIT OR Apache-2.0' }),
        disposition: 'allowed',
      }),
      expect.objectContaining({
        ecosystem: 'phase4-native-voice',
        name: 'phase4-blocked-voice',
        disposition: 'blocked',
      }),
    ]))
    const serialized = JSON.stringify(report)
    expect(serialized).not.toContain(fixture.root)
    expect(serialized).not.toContain(tmpdir())
  })

  it('rejects explicit symlink and source commit mismatch inputs', () => {
    const fixture = createFixture()
    const symlink = join(fixture.root, 'pnpm-lock-link.yaml')
    symlinkSync(fixture.pnpmLock, symlink)

    const symlinkResult = runInventory(fixture, ['--pnpm-lock', symlink])
    expect(symlinkResult.status).not.toBe(0)
    expect(readReport(fixture).blockers[0].detail).toContain('explicit input must not be a symlink')

    const mismatchResult = runInventory(fixture, ['--source-commit', '0000000'])
    expect(mismatchResult.status).not.toBe(0)
    expect(readReport(fixture).blockers[0].detail).toContain('source commit mismatch')
  })

  it('accepts a short source commit prefix but records the full HEAD and creates no dash artifact', () => {
    const fixture = createFixture()
    const dashArtifact = join(repoRoot, '-')
    const result = runInventory(fixture, ['--source-commit', currentHead().slice(0, 8)])

    expect(result.status).not.toBe(0)
    expect(readReport(fixture).source.commit).toBe(currentHead())
    expect(existsSync(dashArtifact)).toBe(false)
  })

  it('wires the package script and release workflow before lightweight release checks', () => {
    const packageJson = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8'))
    expect(packageJson.scripts[expectedPackageScriptName]).toBe(expectedPackageScriptCommand)

    const workflow = readFileSync(join(repoRoot, '.github', 'workflows', 'release.yml'), 'utf8')
    const inventoryStep = workflow.indexOf(expectedWorkflowCommand)
    const uploadStep = workflow.indexOf(expectedReportPath)
    const releaseCheckStep = workflow.indexOf('Run lightweight release check')
    expect(inventoryStep).toBeGreaterThan(-1)
    expect(uploadStep).toBeGreaterThan(inventoryStep)
    expect(releaseCheckStep).toBeGreaterThan(uploadStep)
  })
})

function writeJson(path: string, value: unknown) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
}

function currentHead() {
  const result = spawnSync('git', ['rev-parse', 'HEAD'], {
    cwd: repoRoot,
    encoding: 'utf8',
  })
  if (result.status !== 0) throw new Error('unable to read git HEAD')
  return result.stdout.trim()
}
