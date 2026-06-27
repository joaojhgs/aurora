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
