import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
const kotlinPath =
  'apps/aurora-tauri/src-tauri/android/aurora-native-plugin/src/main/java/dev/aurora/tauri/nativeplugin/AuroraNativePlugin.kt'
const androidPermissionPath =
  'apps/aurora-tauri/src-tauri/permissions/aurora-android-native-plugin.toml'
const androidCapabilityPath =
  'apps/aurora-tauri/src-tauri/capabilities/aurora-android-thin.json'
const rustPath = 'apps/aurora-tauri/src-tauri/src/lib.rs'

function repoText(path: string): string {
  return readFileSync(resolve(repoRoot, path), 'utf8')
}

describe('Android inbound verifier native storage', () => {
  it('implements dedicated Android plugin commands without reopening generic storage', () => {
    const kotlin = repoText(kotlinPath)
    const permission = repoText(androidPermissionPath)
    const capability = repoText(androidCapabilityPath)
    const rust = repoText(rustPath)

    for (const command of [
      'inboundVerifierGet',
      'inboundVerifierSet',
      'inboundVerifierDelete',
    ]) {
      expect(kotlin).toContain(`fun ${command}(invoke: Invoke)`)
    }
    for (const command of [
      'aurora_inbound_verifier_get',
      'aurora_inbound_verifier_set',
      'aurora_inbound_verifier_delete',
    ]) {
      expect(permission).toContain(command)
    }

    expect(capability).toContain('aurora-android-native-plugin')
    expect(capability).not.toContain('aurora-inbound-verifier-storage')
    expect(capability).not.toContain('aurora-secure-storage')
    expect(kotlin).toContain('INBOUND_VERIFIER_KEY_PREFIX = "aurora.peer-host.inbound-verifier.v1"')
    expect(kotlin).toContain('INBOUND_VERIFIER_STORAGE_PREFIX = "aurora.mesh.inbound-verifier."')
    expect(kotlin).toContain('inbound verifier namespace is opaque-only')
    expect(kotlin).toContain('allowedGenericSecureStorage", false')
    expect(rust).toContain('run_android_plugin_command(')
    for (const command of [
      'inboundVerifierGet',
      'inboundVerifierSet',
      'inboundVerifierDelete',
    ]) {
      expect(rust).toContain(`"${command}"`)
    }
  })

  it('locks selector validation, canonical record shape, and opaque account derivation', () => {
    const kotlin = repoText(kotlinPath)
    const inboundSetBody = kotlin.slice(
      kotlin.indexOf('fun inboundVerifierSet(invoke: Invoke)'),
      kotlin.indexOf('@Command', kotlin.indexOf('fun inboundVerifierDelete(invoke: Invoke)')),
    )

    for (const invariant of [
      'decodeSdkKeyPart(parts[0], "verifierPeerId")',
      'decodeSdkKeyPart(parts[1], "claimantPeerId")',
      'decodeSdkKeyPart(parts[2], "roomName")',
      'decodeSdkKeyPart(parts[3], "tokenId")',
      'encodeSdkKeyPart(verifierPeerId) != parts[0]',
      'validateInboundVerifierSecretValueForSelector(args.value, selector)',
      'inboundVerifierSelectorMatchesRecord(selector, record)',
      'INBOUND_VERIFIER_STORAGE_PREFIX + sha256Hex(key.toByteArray(Charsets.UTF_8))',
      '\\"tokenHashHex\\":${canonicalJsonQuote(record.tokenHashHex)}',
      'validateLowerHex64("tokenHashHex", record.tokenHashHex)',
      'canonicalInboundVerifierSecretValue(record) != value',
      'inbound verifier value contains unsupported secret material',
      'securePrefs().edit().remove(account).apply()',
    ]) {
      expect(kotlin).toContain(invariant)
    }

    expect(kotlin).toContain('if (value.length != 64 || !value.all { it in \'0\'..\'9\' || it in \'a\'..\'f\' })')
    expect(kotlin).not.toMatch(/Log\.[a-z]\([^)]*(tokenHashHex|rawBearerToken|verifierKey|proof)/u)
    expect(inboundSetBody).not.toContain('securePrefs().edit().putString(args.key')
  })
})
