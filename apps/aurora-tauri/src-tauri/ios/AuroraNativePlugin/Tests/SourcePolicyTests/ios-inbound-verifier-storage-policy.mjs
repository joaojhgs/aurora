import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const testDir = dirname(fileURLToPath(import.meta.url))
const pluginRoot = resolve(testDir, '..', '..')
const tauriRoot = resolve(pluginRoot, '..', '..')
const storageSource = readFileSync(
  resolve(pluginRoot, 'Sources', 'AuroraNativePlugin', 'AuroraThinPeerStorage.swift'),
  'utf8',
)
const pluginSource = readFileSync(
  resolve(pluginRoot, 'Sources', 'AuroraNativePlugin', 'AuroraNativePlugin.swift'),
  'utf8',
)
const iosPermission = readFileSync(
  resolve(tauriRoot, 'permissions', 'aurora-ios-native-plugin.toml'),
  'utf8',
)
const iosCapability = readFileSync(
  resolve(tauriRoot, 'capabilities', 'aurora-ios-thin.json'),
  'utf8',
)

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

for (const command of ['inboundVerifierGet', 'inboundVerifierSet', 'inboundVerifierDelete']) {
  assert(
    pluginSource.includes(`@objc public func ${command}(_ invoke: Invoke)`),
    `missing Swift command ${command}`,
  )
}

for (const manifestEntry of [
  '"aurora.inboundVerifierStorage": true',
  '"native.inboundVerifierStorage": true',
  '"aurora.inboundVerifierStorage": "available"',
  '"native.inboundVerifierStorage": "available"',
]) {
  assert(pluginSource.includes(manifestEntry), `missing iOS manifest entry ${manifestEntry}`)
}

for (const command of [
  'aurora_inbound_verifier_get',
  'aurora_inbound_verifier_set',
  'aurora_inbound_verifier_delete',
]) {
  assert(iosPermission.includes(command), `iOS permission must grant ${command}`)
}

assert(
  iosCapability.includes('"aurora-ios-native-plugin"'),
  'iOS thin capability must include the iOS-native plugin permission',
)
assert(
  !iosCapability.includes('"aurora-inbound-verifier-storage"'),
  'iOS thin capability must not reuse the desktop inbound verifier permission',
)
assert(
  !iosCapability.includes('"aurora-secure-storage"'),
  'iOS thin capability must not grant generic secure storage',
)
assert(
  !iosPermission.includes('aurora_secure_storage_get') &&
    !iosPermission.includes('aurora_secure_storage_set') &&
    !iosPermission.includes('aurora_secure_storage_delete'),
  'iOS-native permission must not grant generic secure storage commands',
)

assert(
  storageSource.includes('private let auroraInboundVerifierKeychainService = "dev.aurora.ios.inbound-verifier-storage"'),
  'inbound verifier must use a dedicated iOS Keychain service',
)
assert(
  storageSource.includes('private let auroraInboundVerifierAccountPrefix = "aurora.mesh.inbound-verifier."'),
  'inbound verifier must use a dedicated account prefix',
)
assert(
  storageSource.includes('auroraInboundVerifierAccountPrefix + Data(SHA256.hash(data: Data(key.utf8))).lowercaseHex'),
  'inbound verifier account must be SHA-256-derived from the exact SDK key',
)
assert(
  !storageSource.includes('auroraThinPeerAccountPrefix + Data(SHA256.hash(data: Data(key.utf8)))'),
  'inbound verifier must not share the peer reconnect credential account namespace',
)
assert(
  storageSource.includes('let request: AuroraInboundVerifierSetRequest'),
  'Swift command args must preserve the Rust request wrapper shape',
)
assert(
  storageSource.includes('private let auroraInboundVerifierKeyPrefix = "aurora.peer-host.inbound-verifier.v1"'),
  'inbound verifier key validation must require the exact SDK namespace',
)
assert(
  storageSource.includes('encodeSdkKeyPart(verifierPeerId) == rawParts[0]') &&
    storageSource.includes('decodeSdkKeyPart'),
  'inbound verifier key validation must require strict decode/re-encode canonicality',
)

for (const equalityCheck of [
  'record.tokenId == selector.tokenId',
  'record.claimantPeerId == selector.claimantPeerId',
  'record.verifierPeerId == selector.verifierPeerId',
  'record.roomName == selector.roomName',
]) {
  assert(storageSource.includes(equalityCheck), `missing selector equality check ${equalityCheck}`)
}

for (const rejectedShape of [
  '"rawbearertoken"',
  '"rawtoken"',
  '"proofhex"',
  '"verifierkey"',
  '"secret"',
  '"authorization"',
]) {
  assert(storageSource.includes(rejectedShape), `missing rejected secret shape ${rejectedShape}`)
}

assert(
  storageSource.includes('value.utf8.count <= 8192'),
  'inbound verifier values must reject oversize records',
)
assert(
  storageSource.includes('key.utf8.count <= 4096'),
  'inbound verifier keys must reject oversize selectors',
)
assert(
  storageSource.includes('validateLowerHex64(record.tokenHashHex)'),
  'tokenHashHex must be validated as lowercase 64-hex',
)
assert(
  storageSource.includes('guard canonicalInboundVerifierSecretValue(record) == value'),
  'Swift storage must require exact canonical compact JSON bytes before writing',
)

const canonicalOrder = [
  '"version"',
  '"tokenId"',
  '"claimantPeerId"',
  '"verifierPeerId"',
  '"roomName"',
  '"tokenHashHex"',
  '"createdAtMs"',
  '"expiresAtMs"',
  '"revokedAtMs"',
  '"credentialRevision"',
]
let previous = -1
for (const field of canonicalOrder) {
  const next = storageSource.indexOf(`\\"${field.slice(1, -1)}\\":`, storageSource.indexOf('canonicalInboundVerifierSecretValue'))
  assert(next > previous, `canonical JSON field ${field} is out of SDK order`)
  previous = next
}

const key = 'aurora.peer-host.inbound-verifier.v1:desktop-peer:claimant-peer:mesh-room:token-1'
const account = `aurora.mesh.inbound-verifier.${createHash('sha256').update(key).digest('hex')}`
assert(
  account === 'aurora.mesh.inbound-verifier.84ce759576a3e72b78c5730ea3f51ffaf65160ad6fc0381f20e6b7a3205871f8',
  'test fixture must prove exact SDK-key account derivation',
)

assert(!pluginSource.includes('rawBearerToken'), 'plugin command wrappers must not expose raw bearer tokens')
assert(!pluginSource.includes('tokenHashHex'), 'plugin command wrappers must not log or expose verifier hashes')

console.log('iOS inbound verifier storage source policy passed')
