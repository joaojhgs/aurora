// @vitest-environment node

import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const repoRoot = resolve(packageRoot, '..', '..')

function targetDependencyBlock(manifest: string, target: string): string {
  const escapedTarget = target.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const match = manifest.match(
    new RegExp(
      `\\[target\\.'cfg\\(${escapedTarget}\\)'\\.dependencies\\]([\\s\\S]*?)(?=\\n\\[|$)`,
    ),
  )
  return match?.[1] ?? ''
}

describe('iOS Sherpa feature policy', () => {
  it('enables the full local Sherpa voice runtime for the Tauri iOS target', () => {
    const tauriManifest = readFileSync(resolve(packageRoot, 'src-tauri', 'Cargo.toml'), 'utf8')
    const nativeManifest = readFileSync(
      resolve(repoRoot, 'rust', 'crates', 'aurora-voice-native', 'Cargo.toml'),
      'utf8',
    )
    const iosDependencies = targetDependencyBlock(tauriManifest, 'target_os = "ios"')
    const androidDependencies = targetDependencyBlock(tauriManifest, 'target_os = "android"')
    const desktopDependencies = targetDependencyBlock(
      tauriManifest,
      'any(target_os = "macos", windows, target_os = "linux")',
    )

    expect(iosDependencies).toContain(
      'aurora-voice-native = { path = "../../../rust/crates/aurora-voice-native", features = ["ios-sherpa"] }',
    )
    expect(androidDependencies).toContain('features = ["native-sherpa-tts"]')
    expect(desktopDependencies).toContain('features = ["desktop-sherpa-tts"]')

    const iosFeature = nativeManifest.match(/ios-sherpa = \[([\s\S]*?)\]/)?.[1] ?? ''
    expect(iosFeature).toContain('"aurora-voice-sherpa/native-vad"')
    expect(iosFeature).toContain('"aurora-voice-sherpa/native-kws"')
    expect(iosFeature).toContain('"aurora-voice-sherpa/native-stt"')
    expect(iosFeature).toContain('"aurora-voice-sherpa/native-tts"')
  })
})
