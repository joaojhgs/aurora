// @vitest-environment node

import { execFileSync, spawnSync } from 'node:child_process'
import { crc32, deflateRawSync } from 'node:zlib'
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const script = join(packageRoot, 'scripts', 'assert-native-voice-artifact-policy.mjs')
const appImageNormalizer = join(packageRoot, 'scripts', 'normalize-appimage-bundle.mjs')
const wrapper = join(packageRoot, 'scripts', 'verify-desktop-client-bundle.mjs')
const prepareClient = join(packageRoot, 'scripts', 'prepare-client-bundle.mjs')

interface PolicyContext {
  root: string
  artifactRoot: string
  reportPath: string
}

function createContext(): PolicyContext {
  const root = mkdtempSync(join(tmpdir(), 'aurora-native-voice-artifact-policy-'))
  return {
    root,
    artifactRoot: join(root, 'bundle'),
    reportPath: join(root, 'native-voice-artifact-policy.json'),
  }
}

function runPolicy(context: PolicyContext) {
  return spawnSync(process.execPath, [
    script,
    '--root',
    context.artifactRoot,
    '--report',
    context.reportPath,
  ], {
    cwd: packageRoot,
    encoding: 'utf8',
  })
}

function runWrapper(context: PolicyContext) {
  const configPath = join(context.root, 'tauri.client.conf.json')
  execFileSync(process.execPath, [prepareClient], {
    cwd: packageRoot,
    env: {
      ...process.env,
      AURORA_TAURI_CLIENT_CONFIG_PATH: configPath,
      AURORA_TAURI_CLIENT_REPORT_PATH: join(context.root, 'desktop-client-bundle-prepare.json'),
    },
  })
  return spawnSync(process.execPath, [wrapper, '--allow-missing-bundle'], {
    cwd: packageRoot,
    encoding: 'utf8',
    env: {
      ...process.env,
      AURORA_TAURI_CLIENT_CONFIG_PATH: configPath,
      AURORA_TAURI_CLIENT_PROOF_REPORT_PATH: join(context.root, 'desktop-client-bundle-proof.json'),
      AURORA_TAURI_THIN_BUNDLE_DIR: join(context.root, 'missing-bundle'),
      AURORA_NATIVE_VOICE_ARTIFACT_ROOT: join(context.root, 'missing-bundle'),
      AURORA_NATIVE_VOICE_ARTIFACT_POLICY_REPORT_PATH: context.reportPath,
    },
  })
}

function writeArtifact(context: PolicyContext, relativePath: string, content = 'placeholder\n') {
  const path = join(context.artifactRoot, relativePath)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, content)
}

describe('native voice desktop artifact policy', () => {
  it('allows approved Rust native voice libraries in no-sidecar desktop artifacts', () => {
    const context = createContext()
    writeArtifact(context, 'usr/bin/aurora', 'native shell\n')
    writeArtifact(context, 'usr/lib/libaurora_native_voice.so', 'rust native voice library\n')
    writeArtifact(context, 'share/applications/aurora.desktop', '[Desktop Entry]\nName=Aurora\n')

    const result = runPolicy(context)

    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout).toContain('Native voice artifact policy passed')
    const report = JSON.parse(readFileSync(context.reportPath, 'utf8'))
    expect(report).toMatchObject({
      bundleMode: 'native-voice-desktop-client',
      checkedFiles: 3,
      checkedArchives: 0,
      secretsRedacted: true,
    })
    expect(report.approvedNativeVoiceLibraries).toEqual([
      'usr/lib/libaurora_native_voice.so',
    ])
    expect(report.forbiddenMatches).toEqual([])
  })

  it('allows browser speech engine code while keeping model weights out of release artifacts', () => {
    const context = createContext()
    writeArtifact(context, 'assets/sherpa-onnx-wasm-main-vad-asr.js', 'export const createRuntime = () => ({})\n')
    writeArtifact(context, 'assets/sherpa-onnx-wasm-main-vad-asr.wasm', 'wasm engine bytes\n')
    writeArtifact(context, 'assets/aurora-speech-worker.js', 'self.onmessage = () => undefined\n')
    writeArtifact(context, 'assets/aurora-audio-worklet.js', 'registerProcessor("aurora-audio", class {})\n')
    writeArtifact(context, 'assets/speech-model-catalog.json', '{"entries":[]}\n')

    const result = runPolicy(context)

    expect(result.status, result.stderr).toBe(0)
    const report = JSON.parse(readFileSync(context.reportPath, 'utf8'))
    expect(report.forbiddenMatches).toEqual([])
  })

  it('rejects bundled Python runtimes and sidecar resources', () => {
    const context = createContext()
    writeArtifact(context, 'usr/bin/aurora-sidecar-x86_64-unknown-linux-gnu', '#!/bin/sh\n')
    writeArtifact(context, 'usr/lib/libpython3.11.so', 'python runtime\n')
    writeArtifact(context, 'resources/app/services/config/config_defaults.json', '{}\n')

    const result = runPolicy(context)

    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('Native voice artifact policy failed')
    expect(result.stderr).toContain('python-sidecar')
    expect(result.stderr).toContain('python-runtime')
    expect(result.stderr).toContain('python-source')
  })

  it('rejects bundled speech model and voice assets', () => {
    const context = createContext()
    writeArtifact(context, 'usr/lib/libaurora_native_voice.so', 'rust native voice library\n')
    writeArtifact(context, 'resources/models/stt/english.onnx', 'model bytes\n')
    writeArtifact(context, 'resources/models/tts/english-voice.wav', 'voice sample bytes\n')
    writeArtifact(context, 'resources/models/stt/english-model.data', 'packed model bytes\n')
    writeArtifact(context, 'resources/models/stt/english-tokens.txt', 'token list\n')

    const result = runPolicy(context)

    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('speech-model-asset')
    expect(result.stderr).toContain('speech-model-support-file')
  })

  it('allows license/catalog metadata while still rejecting secrets', () => {
    const context = createContext()
    writeArtifact(
      context,
      'assets/voice-catalog.json',
      '{"id":"pockettts-example","license":"CC-BY-NC","download":"https://upstream.invalid/voice"}\n',
    )

    const allowed = runPolicy(context)

    expect(allowed.status, allowed.stderr).toBe(0)

    writeArtifact(context, '.env', 'OPENAI_API_KEY=sk-123456789012345678901234\n')
    const rejected = runPolicy(context)

    expect(rejected.status).not.toBe(0)
    expect(rejected.stderr).toContain('secret-file')
    expect(rejected.stderr).toContain('api-secret-text')
  })

  it('scans zip-style app archives deterministically', () => {
    const context = createContext()
    mkdirSync(context.artifactRoot, { recursive: true })
    writeZip(join(context.artifactRoot, 'Aurora.zip'), [
      'Aurora/usr/lib/libaurora_voice_runtime.so',
      'Aurora/resources/models/tts/pockettts.onnx',
    ])

    const first = runPolicy(context)
    const firstReport = readFileSync(context.reportPath, 'utf8')
    const second = runPolicy(context)
    const secondReport = readFileSync(context.reportPath, 'utf8')

    expect(first.status).not.toBe(0)
    expect(second.status).not.toBe(0)
    expect(first.stderr).toContain('speech-model-asset')
    expect(firstReport).toBe(secondReport)
    const report = JSON.parse(firstReport)
    expect(report.checkedArchives).toBe(1)
    expect(report.checkedArchiveEntries).toBe(2)
    expect(report.approvedNativeVoiceLibraries).toEqual([
      'Aurora/usr/lib/libaurora_voice_runtime.so',
    ])
  })

  it('rejects forbidden symlinks and records their targets', () => {
    const context = createContext()
    mkdirSync(join(context.artifactRoot, 'usr', 'lib'), { recursive: true })
    symlinkSync('/tmp/site-packages', join(context.artifactRoot, 'usr', 'lib', 'voice-link'))

    const result = runPolicy(context)

    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('symlink-unsupported')
    expect(result.stderr).toContain('python-runtime')
    const report = JSON.parse(readFileSync(context.reportPath, 'utf8'))
    expect(report.checkedSymlinks).toBe(1)
    expect(JSON.stringify(report.forbiddenMatches)).toContain('<tmp>/site-packages')
  })

  it('allows package-internal symlinks while rejecting links that escape the artifact root', () => {
    const context = createContext()
    writeArtifact(context, 'usr/share/applications/aurora.desktop', '[Desktop Entry]\nName=Aurora\n')
    mkdirSync(join(context.artifactRoot, 'usr', 'share', 'icons'), { recursive: true })
    symlinkSync('../applications/aurora.desktop', join(context.artifactRoot, 'usr', 'share', 'icons', 'aurora.desktop'))

    const result = runPolicy(context)

    expect(result.status, result.stderr).toBe(0)
    const report = JSON.parse(readFileSync(context.reportPath, 'utf8'))
    expect(report.checkedSymlinks).toBe(1)
    expect(report.forbiddenMatches).toEqual([])
  })

  it('rejects AppImage symlinks that only resolve through the original build directory', () => {
    const context = createContext()
    const externalIcon = join(context.artifactRoot, 'Aurora.png')
    const image = join(context.artifactRoot, 'Aurora.AppImage')
    writeArtifact(context, 'Aurora.png', 'icon bytes\n')
    writeArtifact(
      context,
      'Aurora.AppImage',
      `#!/usr/bin/env node
const { mkdirSync, symlinkSync, writeFileSync } = require('node:fs')
const { join } = require('node:path')
const root = join(process.cwd(), 'squashfs-root')
mkdirSync(root, { recursive: true })
writeFileSync(join(root, 'Aurora.png'), 'packaged icon\\n')
symlinkSync(${JSON.stringify(externalIcon)}, join(root, '.DirIcon'))
`,
    )
    chmodSync(image, 0o755)

    const result = runPolicy(context)

    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('symlink-unsupported')
    expect(result.stderr).toContain('appimage:Aurora.AppImage:.DirIcon')
  })

  it('normalizes an absolute AppImage directory icon to a packaged relative link', () => {
    const context = createContext()
    const appDir = join(context.root, 'Aurora.AppDir')
    const icon = join(appDir, 'Aurora.png')
    mkdirSync(appDir, { recursive: true })
    writeFileSync(icon, 'icon bytes\n')
    symlinkSync(icon, join(appDir, '.DirIcon'))

    const result = spawnSync(process.execPath, [appImageNormalizer, '--appdir', appDir], {
      cwd: packageRoot,
      encoding: 'utf8',
    })

    expect(result.status, result.stderr).toBe(0)
    expect(readlinkSync(join(appDir, '.DirIcon'))).toBe('Aurora.png')
  })

  it('rejects secrets inside zip entry content', () => {
    const context = createContext()
    mkdirSync(context.artifactRoot, { recursive: true })
    writeZip(join(context.artifactRoot, 'Aurora.zip'), [
      ['Aurora/config.json', 'OPENAI_API_KEY=sk-123456789012345678901234\n'],
    ])

    const result = runPolicy(context)

    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('api-secret-text')
    const report = JSON.parse(readFileSync(context.reportPath, 'utf8'))
    expect(report.checkedArchives).toBe(1)
    expect(report.checkedArchiveEntries).toBe(1)
  })

  it('recursively scans nested zip entries for forbidden model assets', () => {
    const context = createContext()
    mkdirSync(context.artifactRoot, { recursive: true })
    const innerZip = createZipBuffer([
      ['models/stt/english.onnx', 'model bytes\n'],
    ])
    writeZip(join(context.artifactRoot, 'Aurora.zip'), [
      ['Aurora/resources/nested.zip', innerZip],
    ])

    const result = runPolicy(context)

    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('speech-model-asset')
    const report = JSON.parse(readFileSync(context.reportPath, 'utf8'))
    expect(report.checkedArchives).toBe(2)
    expect(report.checkedArchiveEntries).toBe(2)
  })

  it('keeps writing redacted reports for malformed zip local offsets', () => {
    const context = createContext()
    mkdirSync(context.artifactRoot, { recursive: true })
    const malformed = createZipBuffer([
      ['Aurora/config.json', 'OPENAI_API_KEY=sk-123456789012345678901234\n'],
    ])
    const centralOffset = malformed.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]))
    malformed.writeUInt32LE(0xfffffff0, centralOffset + 42)
    writeFileSync(join(context.artifactRoot, 'Aurora.zip'), malformed)

    const result = runPolicy(context)

    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('archive-inspection')
    expect(result.stderr).not.toContain('RangeError')
    expect(result.stderr).not.toContain(context.root)
    const reportText = readFileSync(context.reportPath, 'utf8')
    expect(reportText).toContain('archive-inspection')
    expect(reportText).not.toContain('sk-123456789012345678901234')
    expect(reportText).not.toContain(context.root)
  })

  it('rejects unsafe zip entry paths', () => {
    const context = createContext()
    mkdirSync(context.artifactRoot, { recursive: true })
    writeZip(join(context.artifactRoot, 'Aurora.zip'), [
      ['/absolute/config.json', '{}\n'],
      ['../escape/config.json', '{}\n'],
      ['Aurora/bad\u0000name.json', '{}\n'],
    ])

    const result = runPolicy(context)

    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('archive-entry-path')
  })

  it('enforces a global nested archive entry budget', () => {
    const context = createContext()
    mkdirSync(context.artifactRoot, { recursive: true })
    writeZip(
      join(context.artifactRoot, 'Aurora.zip'),
      Array.from({ length: 20_001 }, (_, index) => `entries/${index}.txt`),
    )

    const result = runPolicy(context)

    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('archive-entry-limit')
  })

  it('fails closed when deflated zip output exceeds forged metadata bounds', () => {
    const context = createContext()
    mkdirSync(context.artifactRoot, { recursive: true })
    writeFileSync(
      join(context.artifactRoot, 'Aurora.zip'),
      createForgedDeflateZip('Aurora/config.json', '{"token":"safe"}\n', 0),
    )

    const result = runPolicy(context)

    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('archive-entry-decode')
  })

  it('extracts DEB installers and rejects bundled model assets inside them', () => {
    const context = createContext()
    const debRoot = join(context.root, 'deb-root')
    mkdirSync(join(debRoot, 'DEBIAN'), { recursive: true })
    mkdirSync(join(debRoot, 'usr', 'share', 'aurora', 'models', 'stt'), { recursive: true })
    writeFileSync(
      join(debRoot, 'DEBIAN', 'control'),
      'Package: aurora\nVersion: 1.0.0\nArchitecture: all\nMaintainer: Aurora\nDescription: Aurora test artifact\n',
    )
    writeFileSync(join(debRoot, 'usr', 'share', 'aurora', 'models', 'stt', 'english.onnx'), 'model bytes\n')
    mkdirSync(context.artifactRoot, { recursive: true })
    execFileSync('dpkg-deb', ['--build', debRoot, join(context.artifactRoot, 'aurora.deb')])

    const result = runPolicy(context)

    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('speech-model-asset')
    const report = JSON.parse(readFileSync(context.reportPath, 'utf8'))
    expect(report.checkedInstallers).toBe(1)
  })

  it('fails closed for recognized installer formats that cannot be inspected', () => {
    const context = createContext()
    writeArtifact(context, 'Aurora.rpm', 'not an rpm\n')
    writeArtifact(context, 'Aurora.dmg', 'not a dmg\n')
    writeArtifact(context, 'Aurora.msi', 'not a msi\n')
    writeArtifact(context, 'Aurora Setup.exe', 'not an installer\n')

    const result = runPolicy(context)

    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('installer-inspection-unavailable')
    expect(result.stderr).toContain('installer-inspection-unsupported')
  })

  it('is wired into the desktop client release bundle command', () => {
    const packageJson = JSON.parse(
      readFileSync(join(packageRoot, 'package.json'), 'utf8'),
    ) as { scripts: Record<string, string> }

    expect(packageJson.scripts['verify:native-voice-artifact-policy']).toBe(
      'node ./scripts/assert-native-voice-artifact-policy.mjs',
    )
    expect(packageJson.scripts['verify:bundle:desktop-client']).toBe(
      'node ./scripts/verify-desktop-client-bundle.mjs',
    )
    expect(packageJson.scripts['normalize:bundle:appimage']).toBe(
      'node ./scripts/normalize-appimage-bundle.mjs',
    )
    expect(packageJson.scripts['build:bundle:desktop-client']).toContain(
      'pnpm normalize:bundle:appimage',
    )
    expect(packageJson.scripts['build:bundle:desktop-client']).toContain(
      'pnpm verify:bundle:desktop-client',
    )
    for (const script of [
      'build:bundle:desktop-local-minimal',
      'build:bundle:local-cpu',
      'build:bundle:local-cuda',
      'build:bundle:local-rocm',
      'build:bundle:local-metal',
      'build:bundle:local-vulkan',
      'build:bundle:local-sycl',
      'build:bundle:local-rpc',
      'build:bundle:full',
    ]) {
      expect(packageJson.scripts[script], script).toContain(
        'pnpm normalize:bundle:appimage',
      )
    }
    expect(packageJson.scripts['build:bundle:linux-rpm:desktop-client']).toContain(
      'pnpm verify:bundle:desktop-client',
    )
  })

  it('maps allow-missing-bundle through the composed desktop verifier', () => {
    const context = createContext()

    const result = runWrapper(context)

    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout).toContain('Desktop client bundle proof passed')
    expect(result.stdout).toContain('Native voice artifact policy passed')
    const nativeReport = JSON.parse(readFileSync(context.reportPath, 'utf8'))
    expect(nativeReport).toMatchObject({
      artifactRootMissing: true,
      allowMissingRoot: true,
    })
  })
})

type ZipEntry = string | [string, string | Buffer]

function writeZip(path: string, entries: ZipEntry[]) {
  writeFileSync(path, createZipBuffer(entries))
}

function createZipBuffer(entries: ZipEntry[]) {
  const chunks: Buffer[] = []
  const central: Buffer[] = []
  let offset = 0

  for (const entry of entries) {
    const [name, value] = Array.isArray(entry) ? entry : [entry, '']
    const nameBuffer = Buffer.from(name)
    const data = Buffer.isBuffer(value) ? value : Buffer.from(value)
    const crc = crc32(data)
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(0, 6)
    local.writeUInt16LE(0, 8)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(data.length, 18)
    local.writeUInt32LE(data.length, 22)
    local.writeUInt16LE(nameBuffer.length, 26)
    local.writeUInt16LE(0, 28)
    chunks.push(local, nameBuffer, data)

    const header = Buffer.alloc(46)
    header.writeUInt32LE(0x02014b50, 0)
    header.writeUInt16LE(20, 4)
    header.writeUInt16LE(20, 6)
    header.writeUInt16LE(0, 8)
    header.writeUInt16LE(0, 10)
    header.writeUInt32LE(crc, 16)
    header.writeUInt32LE(data.length, 20)
    header.writeUInt32LE(data.length, 24)
    header.writeUInt16LE(nameBuffer.length, 28)
    header.writeUInt16LE(0, 30)
    header.writeUInt16LE(0, 32)
    header.writeUInt32LE(offset, 42)
    central.push(header, nameBuffer)
    offset += local.length + nameBuffer.length + data.length
  }

  const centralOffset = offset
  const centralSize = central.reduce((total, chunk) => total + chunk.length, 0)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(entries.length, 8)
  eocd.writeUInt16LE(entries.length, 10)
  eocd.writeUInt32LE(centralSize, 12)
  eocd.writeUInt32LE(centralOffset, 16)
  return Buffer.concat([...chunks, ...central, eocd])
}

function createForgedDeflateZip(name: string, content: string, declaredSize: number) {
  const nameBuffer = Buffer.from(name)
  const data = deflateRawSync(Buffer.from(content))
  const crc = crc32(Buffer.from(content))
  const local = Buffer.alloc(30)
  local.writeUInt32LE(0x04034b50, 0)
  local.writeUInt16LE(20, 4)
  local.writeUInt16LE(0, 6)
  local.writeUInt16LE(8, 8)
  local.writeUInt32LE(crc, 14)
  local.writeUInt32LE(data.length, 18)
  local.writeUInt32LE(declaredSize, 22)
  local.writeUInt16LE(nameBuffer.length, 26)
  const centralOffset = local.length + nameBuffer.length + data.length
  const header = Buffer.alloc(46)
  header.writeUInt32LE(0x02014b50, 0)
  header.writeUInt16LE(20, 4)
  header.writeUInt16LE(20, 6)
  header.writeUInt16LE(0, 8)
  header.writeUInt16LE(8, 10)
  header.writeUInt32LE(crc, 16)
  header.writeUInt32LE(data.length, 20)
  header.writeUInt32LE(declaredSize, 24)
  header.writeUInt16LE(nameBuffer.length, 28)
  header.writeUInt32LE(0, 42)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(1, 8)
  eocd.writeUInt16LE(1, 10)
  eocd.writeUInt32LE(header.length + nameBuffer.length, 12)
  eocd.writeUInt32LE(centralOffset, 16)
  return Buffer.concat([local, nameBuffer, data, header, nameBuffer, eocd])
}
