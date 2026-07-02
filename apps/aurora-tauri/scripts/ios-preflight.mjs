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
