import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const scriptDir = fileURLToPath(new URL('.', import.meta.url))
const appDir = join(scriptDir, '..')
const repoRoot = join(appDir, '..', '..')
const gatePath = join(appDir, 'src-tauri', 'ios', 'preflight.json')

const args = new Set(process.argv.slice(2))
const policyOnly = args.has('--policy-only')
const requireMacos = args.has('--require-macos')
const requireIosProject = args.has('--require-ios-project')
const requireSigningEnv = args.has('--require-signing-env')
const validateIpa = args.has('--validate-ipa')

const gate = readJson(gatePath)

validateGateShape(gate)
validatePolicyCopy()
validateThinWebRtcContract()

if (!policyOnly) {
  validateHost()
  validateXcode()
  if (requireIosProject) validateIosProject()
  if (requireSigningEnv) validateSigningEnv()
  if (validateIpa) validateIpaArtifact()
}

console.log(`iOS preflight passed: ${policyOnly ? 'policy' : 'macOS/Xcode'} checks`)

function validateGateShape(value) {
  assert(value.platform === 'ios', 'iOS preflight platform must be ios')
  assert(value.policyCopy === 'Siri/Shortcuts/App Intents integration', 'policy copy must use the approved iOS wording')
  assert(Array.isArray(value.integrations) && value.integrations.length > 0, 'integrations must be listed')
  assert(Array.isArray(value.releaseGates) && value.releaseGates.length >= 4, 'preflight checks must include build, simulator, share, and signing checks')
  assert(Array.isArray(value.deviceMatrix) && value.deviceMatrix.length >= 2, 'device matrix must include simulator and physical-device rows')
  assert(value.unsupportedClaims.includes('default system assistant'), 'unsupported iOS system assistant claim must be explicit')

  for (const integration of value.integrations) {
    assert(integration.id && integration.label && integration.status, `integration ${integration.id ?? '<missing>'} is incomplete`)
    assert(integration.privacyClass, `integration ${integration.id} must declare privacyClass`)
    for (const action of integration.actions ?? []) {
      assert(action.id && action.backendMethod && action.privacyClass && action.policy, `integration action ${action.id ?? '<missing>'} is incomplete`)
    }
  }
}

function validatePolicyCopy() {
  const roots = [
    join(repoRoot, 'packages', 'aurora-ui', 'src'),
    join(repoRoot, 'apps', 'aurora-web', 'app'),
    join(repoRoot, 'apps', 'aurora-tauri', 'src'),
    join(repoRoot, 'modules', 'ui-mock-reference')
  ]
  const badPatterns = [/replace Siri/i, /Siri replacement/i]
  const offenders = []
  for (const root of roots) {
    for (const file of walk(root)) {
      if (!/\.(tsx?|jsx?)$/.test(file)) continue
      const text = readFileSync(file, 'utf8')
      for (const pattern of badPatterns) {
        if (pattern.test(text)) offenders.push(`${relative(repoRoot, file)} matches ${pattern}`)
      }
    }
  }
  assert(offenders.length === 0, `iOS UI copy must say "${gate.policyCopy}" and avoid replacement claims:\n${offenders.join('\n')}`)
}

function validateThinWebRtcContract() {
  const swiftPlugin = readFileSync(
    join(appDir, 'src-tauri', 'ios', 'AuroraNativePlugin', 'Sources', 'AuroraNativePlugin', 'AuroraNativePlugin.swift'),
    'utf8'
  )
  const swiftStorage = readFileSync(
    join(appDir, 'src-tauri', 'ios', 'AuroraNativePlugin', 'Sources', 'AuroraNativePlugin', 'AuroraThinPeerStorage.swift'),
    'utf8'
  )
  const rustBridge = readFileSync(join(appDir, 'src-tauri', 'src', 'lib.rs'), 'utf8')
  const runtime = readFileSync(join(appDir, 'src', 'aurora-client.ts'), 'utf8')
  const packageJson = readJson(join(appDir, 'package.json'))
  const prepareThinBundle = readFileSync(
    join(appDir, 'scripts', 'prepare-ios-thin-bundle.mjs'),
    'utf8'
  )
  const buildThinBundle = readFileSync(
    join(appDir, 'scripts', 'build-ios-thin-bundle.mjs'),
    'utf8'
  )
  const capability = readJson(join(appDir, 'src-tauri', 'capabilities', 'aurora-ios-thin.json'))
  const overlay = readJson(join(appDir, 'src-tauri', 'tauri.ios-thin.conf.json'))

  for (const command of [
    'thinPeerCredentialSet',
    'thinPeerCredentialStatus',
    'thinPeerCredentialDelete',
    'thinPeerReconnectProve',
    'thinProfileGet',
    'thinProfileSet'
  ]) {
    assert(swiftPlugin.includes(`@objc public func ${command}`), `iOS native plugin is missing ${command}`)
    assert(rustBridge.includes(`"${command}"`), `Rust iOS bridge is missing ${command}`)
  }
  for (const invariant of [
    'kSecClassGenericPassword',
    'kSecAttrAccessibleWhenUnlockedThisDeviceOnly',
    'kSecAttrSynchronizable as String: kCFBooleanFalse',
    'HMAC<SHA256>.authenticationCode',
    'aurora.mesh.reconnect-proof.v1\\u{0}',
    '.sortedKeys',
    '.withoutEscapingSlashes',
    'Data(ensureAscii(serialized).utf8)',
    'for codeUnit in value.utf16',
    '"rawGetter": false',
    '"allowedGenericSecureStorage": false',
    '"redactedFields": ["rawBearerToken"]'
  ]) {
    assert(swiftStorage.includes(invariant), `iOS thin storage is missing invariant ${invariant}`)
  }
  assert(!swiftStorage.includes('func thinPeerCredentialGet'), 'iOS thin storage must not expose a raw credential getter')
  assert(runtime.includes('isAndroidTauriRuntime() || isIosTauriRuntime()'), 'iOS must use the shared mobile WebView thin runtime')
  assert(runtime.includes('isIosTauriRuntime()'), 'iOS must use the native opaque peer credential store')

  for (const permission of ['aurora-thin-profile', 'aurora-thin-peer-credentials', 'aurora-ios-native-plugin']) {
    assert(capability.permissions.includes(permission), `iOS thin capability is missing ${permission}`)
  }
  for (const forbidden of ['aurora-main', 'aurora-secure-storage', 'aurora-local-file', 'aurora-audio-bridge']) {
    assert(!capability.permissions.includes(forbidden), `iOS thin capability must not include ${forbidden}`)
  }
  assert(overlay.app.security.capabilities.includes('aurora-ios-thin'), 'iOS thin overlay must select aurora-ios-thin')
  assert(Array.isArray(overlay.bundle.externalBin) && overlay.bundle.externalBin.length === 0, 'iOS thin overlay must not bundle external binaries')
  assert(Object.keys(overlay.bundle.resources).length === 0, 'iOS thin overlay must not bundle sidecar resources')
  assert(packageJson.scripts['ios:prepare:thin'] === 'node ./scripts/prepare-ios-thin-bundle.mjs', 'iOS thin prepare command must generate an exact-origin overlay')
  assert(packageJson.scripts['ios:build:thin:simulator'] === 'node ./scripts/build-ios-thin-bundle.mjs', 'iOS thin simulator build must use the generated overlay wrapper')
  for (const invariant of [
    'AURORA_TAURI_IOS_ALLOWED_REMOTE_ORIGINS',
    "capabilities: ['aurora-ios-thin', 'aurora-mobile-mesh']",
    'externalBin: []',
    'resources: {}',
    "if (!['https:', 'wss:'].includes(url.protocol))",
    "url.pathname !== '/'",
    'url.username || url.password',
    'url.search',
    'url.hash'
  ]) {
    assert(prepareThinBundle.includes(invariant), `iOS thin overlay generator is missing ${invariant}`)
  }
  for (const invariant of [
    'AURORA_TAURI_IOS_THIN_CONFIG_PATH',
    "'--config',",
    "'aarch64-sim'",
    'pythonSidecarStaged: false'
  ]) {
    assert(buildThinBundle.includes(invariant), `iOS thin build wrapper is missing ${invariant}`)
  }
}

function validateHost() {
  if (requireMacos) {
    assert(process.platform === 'darwin', 'iOS build/signing gates require macOS with Xcode')
  }
}

function validateXcode() {
  if (process.platform !== 'darwin') return
  execFileSync('xcodebuild', ['-version'], { stdio: 'inherit' })
  execFileSync('xcrun', ['--find', 'altool'], { stdio: 'inherit' })
}

function validateIosProject() {
  const appleProject = join(appDir, 'src-tauri', 'gen', 'apple')
  assert(
    existsSync(appleProject),
    'Tauri iOS project is missing. Run `pnpm --filter @aurora/tauri-ui tauri ios init` on macOS and commit the generated project before preflight builds.'
  )
}

function validateSigningEnv() {
  const hasApiIdentity = Boolean(process.env.APPLE_API_KEY_ID && process.env.APPLE_API_ISSUER)
  const hasKeyMaterial = Boolean(process.env.APPLE_API_KEY_PATH || process.env.APPLE_API_PRIVATE_KEY)
  assert(hasApiIdentity && hasKeyMaterial, 'App Store Connect dry run requires APPLE_API_KEY_ID, APPLE_API_ISSUER, and APPLE_API_KEY_PATH or APPLE_API_PRIVATE_KEY')
}

function validateIpaArtifact() {
  const ipa = join(appDir, 'src-tauri', 'gen', 'apple', 'build', 'arm64', 'Aurora.ipa')
  assert(existsSync(ipa), `Expected iOS IPA artifact at ${relative(repoRoot, ipa)}`)
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'))
}

function* walk(root) {
  if (!existsSync(root)) return
  for (const entry of readdirSync(root)) {
    const path = join(root, entry)
    if (entry === 'node_modules' || entry === 'dist' || entry === '.next') continue
    if (statSync(path).isDirectory()) {
      yield* walk(path)
    } else {
      yield path
    }
  }
}

function assert(condition, message) {
  if (!condition) {
    console.error(message)
    process.exit(1)
  }
}
