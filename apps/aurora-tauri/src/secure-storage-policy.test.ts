import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const webStorageTerms = ['local' + 'Storage', 'session' + 'Storage']
const iosNativePluginPath =
  'apps/aurora-tauri/src-tauri/ios/AuroraNativePlugin/Sources/AuroraNativePlugin/AuroraNativePlugin.swift'

describe('Tauri secure storage policy', () => {
  it('keeps credential persistence out of browser web storage', () => {
    const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
    const files = [
      'apps/aurora-tauri/src/aurora-client.ts',
      'packages/aurora-sdk/src/tauri.ts',
      iosNativePluginPath
    ]

    for (const file of files) {
      const source = readFileSync(resolve(repoRoot, file), 'utf8')
      for (const term of webStorageTerms) {
        expect(source, `${file} must not reference ${term}`).not.toContain(term)
      }
    }
  })

  it('persists onboarding mode preference only through the platform secure-storage namespace', () => {
    const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
    const runtimeSource = readFileSync(resolve(repoRoot, 'apps/aurora-tauri/src/aurora-client.ts'), 'utf8')
    const onboardingSource = readFileSync(resolve(repoRoot, 'packages/aurora-ui/src/onboarding-view.tsx'), 'utf8')

    expect(runtimeSource).toContain("ONBOARDING_MODE_KEY = 'aurora.session.onboarding-mode'")
    expect(runtimeSource).toContain('secureStorageGet(ONBOARDING_MODE_KEY)')
    expect(runtimeSource).toContain('secureStorageSet(ONBOARDING_MODE_KEY, modeId)')
    expect(runtimeSource).toContain('browser thin mode preference is memory-only; no web storage persistence')
    expect(onboardingSource).toContain('isSupportedModeId(modeId)')
    for (const term of webStorageTerms) {
      expect(`${runtimeSource}\n${onboardingSource}`, `selected mode must not use ${term}`).not.toContain(term)
    }
  })

  it('documents iOS biometric credential scope without system assistant ownership claims', () => {
    const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
    const swift = readFileSync(
      resolve(repoRoot, iosNativePluginPath),
      'utf8'
    )
    const plist = readFileSync(resolve(repoRoot, 'apps/aurora-tauri/src-tauri/Info.ios.plist'), 'utf8')

    expect(swift).toContain('LocalAuthentication')
    expect(swift).toContain('secretsRedacted')
    expect(swift).toContain('confirmationOnly')
    expect(plist).toContain('NSFaceIDUsageDescription')
    expect(`${swift}\n${plist}`).toContain('does not allow third-party default assistant ownership')
    expect(`${swift}\n${plist}`).not.toMatch(/"userCopy":\s*"Aurora replaces Siri/i)
  })
})
