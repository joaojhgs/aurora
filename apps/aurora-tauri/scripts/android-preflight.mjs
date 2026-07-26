#!/usr/bin/env node
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, relative as pathRelative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const scriptDir = dirname(fileURLToPath(import.meta.url))
const appDir = resolve(scriptDir, '..')
const repoDir = resolve(appDir, '..', '..')
const args = new Set(process.argv.slice(2))
const strict = args.has('--strict')
const requireAndroidProject = strict || args.has('--require-android-project')
const reportPath = resolve(
  appDir,
  process.env.AURORA_ANDROID_PREFLIGHT_REPORT ?? 'reports/android-preflight.json'
)

const packageJson = readJson(join(appDir, 'package.json'))
const tauriConfig = readJson(join(appDir, 'src-tauri/tauri.conf.json'))
const generatedAndroidProject = process.env.AURORA_ANDROID_GENERATED_PROJECT_DIR
  ? resolve(process.env.AURORA_ANDROID_GENERATED_PROJECT_DIR)
  : firstExistingPath([
      join(appDir, 'src-tauri/gen/android'),
      join(appDir, 'gen/android')
    ])
const canonicalPluginSourceDir = join(appDir, 'src-tauri/android/aurora-native-plugin/src/main/java/dev/aurora/tauri/nativeplugin')
const generatedPluginSourceDir = generatedAndroidProject
  ? join(generatedAndroidProject, 'app/src/main/java/dev/aurora/tauri/nativeplugin')
  : null
const pluginParity = androidNativePluginParity()
const signingEvidence = signingInputs()
const expectedCommands = {
  prepareThin: 'pnpm --filter @aurora/tauri-ui android:prepare:thin',
  apk: 'pnpm --filter @aurora/tauri-ui android:build:thin:apk',
  verifyApk: 'pnpm --filter @aurora/tauri-ui android:verify:thin:apk',
  aab: 'pnpm --filter @aurora/tauri-ui android:build:thin:aab',
  verifyAab: 'pnpm --filter @aurora/tauri-ui android:verify:thin:aab'
}

const checks = [
  check('tauri-cli-script', Boolean(packageJson.scripts?.tauri), 'package exposes the Tauri CLI script'),
  check('android-thin-prepare-command', packageJson.scripts?.['android:prepare:thin'] === 'node ./scripts/prepare-android-thin-bundle.mjs', packageJson.scripts?.['android:prepare:thin'] ?? 'missing'),
  check('android-thin-apk-command', isAndroidThinBuildWrapper(packageJson.scripts?.['android:build:thin:apk'], 'apk'), packageJson.scripts?.['android:build:thin:apk'] ?? 'missing'),
  check('android-thin-aab-command', isAndroidThinBuildWrapper(packageJson.scripts?.['android:build:thin:aab'], 'aab'), packageJson.scripts?.['android:build:thin:aab'] ?? 'missing'),
  check('android-thin-apk-proof-command', packageJson.scripts?.['android:verify:thin:apk']?.includes('assert-android-thin-artifact-clean.mjs --kind apk'), packageJson.scripts?.['android:verify:thin:apk'] ?? 'missing'),
  check('android-thin-aab-proof-command', packageJson.scripts?.['android:verify:thin:aab']?.includes('assert-android-thin-artifact-clean.mjs --kind aab'), packageJson.scripts?.['android:verify:thin:aab'] ?? 'missing'),
  check('android-thin-scripts-python-free', thinScriptsPythonFree(packageJson.scripts ?? {}), 'all *:thin scripts avoid uv/python/prepare-sidecar'),
  check('android-sync-native-plugin-script', packageJson.scripts?.['android:sync-native-plugin'] === 'node ./scripts/install-android-native-plugin.mjs', packageJson.scripts?.['android:sync-native-plugin'] ?? 'missing'),
  check('android-init-syncs-native-plugin', packageJson.scripts?.['android:init']?.includes('android:sync-native-plugin'), packageJson.scripts?.['android:init'] ?? 'missing'),
  check('android-preflight-syncs-native-plugin', ['android:preflight', 'android:preflight:ci', 'android:preflight:strict'].every((name) => packageJson.scripts?.[name]?.includes('android:sync-native-plugin')), 'android preflight package scripts run android:sync-native-plugin before node ./scripts/android-preflight.mjs'),
  check(
    'generated-android-project',
    Boolean(generatedAndroidProject),
    generatedAndroidProject
      ? `generated Android project found at ${relative(generatedAndroidProject)}`
      : 'run pnpm --filter @aurora/tauri-ui tauri android init before strict release builds',
    requireAndroidProject
  ),
  check(
    'android-native-plugin-parity',
    pluginParity.matched,
    pluginParity.detail,
    Boolean(generatedAndroidProject)
  ),
  check('bundle-identifier', Boolean(tauriConfig.identifier), tauriConfig.identifier ?? 'missing identifier', true),
  check('bundle-version', Boolean(tauriConfig.version), tauriConfig.version ?? 'missing version', true),
  check(
    'android-thin-capability-observable',
    androidThinCapabilityObservable(),
    androidThinCapabilityDetail(),
    false
  ),
  check(
    'android-signing-inputs',
    signingEvidence.configured,
    signingEvidence.evidence.join('; '),
    strict
  )
]

const nativePluginPayloads = [
  assistantPayload({
    id: 'role-held',
    state: 'available',
    roleAvailable: true,
    packageQualified: true,
    roleHeld: true,
    requestable: false,
    denied: false,
    oemUnavailable: false,
    fallbackAvailable: true
  }),
  assistantPayload({
    id: 'requestable',
    state: 'needs_native_permission',
    roleAvailable: true,
    packageQualified: true,
    roleHeld: false,
    requestable: true,
    denied: false,
    oemUnavailable: false,
    fallbackAvailable: true
  }),
  assistantPayload({
    id: 'denied',
    state: 'denied',
    roleAvailable: true,
    packageQualified: true,
    roleHeld: false,
    requestable: false,
    denied: true,
    oemUnavailable: false,
    fallbackAvailable: true
  }),
  assistantPayload({
    id: 'oem-unavailable',
    state: 'fallback',
    roleAvailable: false,
    packageQualified: false,
    roleHeld: false,
    requestable: false,
    denied: false,
    oemUnavailable: true,
    fallbackAvailable: true
  })
]

const deviceMatrix = [
  matrixRow('thin-api-24', 'Thin Android API 24+', 'thin', 24, 'universal', 'available', [
    'AAB build artifact',
    'Gateway HTTP smoke'
  ]),
  matrixRow('mesh-api-29', 'Mesh shell Android API 29+', 'mesh', 29, 'arm64-v8a', 'degraded', [
    'capability catalog route smoke',
    'peer/provider identity visible'
  ]),
  matrixRow('assistant-role-qualified', 'Assistant role qualified device', 'assistant-role', 29, 'arm64-v8a', 'needs_native_permission', [
    'RoleManager.isRoleAvailable',
    'package qualification probe',
    'grant or denial result'
  ]),
  matrixRow('assistant-role-held', 'Assistant role held device', 'assistant-role', 29, 'arm64-v8a', 'available', [
    'RoleManager.isRoleHeld=true',
    'native plugin payload smoke'
  ]),
  matrixRow('fallback-oem-unavailable', 'OEM/profile role unavailable fallback', 'fallback', 29, 'x86_64', 'fallback', [
    'RoleManager.isRoleAvailable=false',
    'fallback entrypoint smoke'
  ])
]

const report = {
  generatedAt: new Date().toISOString(),
  packageName: packageJson.name,
  tauriIdentifier: tauriConfig.identifier,
  tauriVersion: tauriConfig.version,
  strict,
  generatedAndroidProject: generatedAndroidProject ? relative(generatedAndroidProject) : null,
  nativePluginParity: pluginParity.report,
  commands: expectedCommands,
  checks,
  signing: {
    configured: signingEvidence.configured,
    evidence: signingEvidence.evidence,
    playUpload: 'manual-first-upload-or-Google-Play-Developer-API',
    secretsRedacted: true
  },
  nativePluginPayloads,
  deviceMatrix,
  sources: [
    'https://v2.tauri.app/distribute/google-play/',
    'https://v2.tauri.app/distribute/sign/android/',
    'https://developer.android.com/reference/android/app/role/RoleManager',
    'https://developer.android.com/reference/androidx/core/role/RoleManagerCompat',
    'https://developer.android.com/reference/android/service/voice/VoiceInteractionService'
  ]
}

mkdirSync(dirname(reportPath), { recursive: true })
writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`)

const failed = checks.filter((item) => item.required && item.status === 'blocked')
console.log(`Android preflight report: ${relative(reportPath)}`)
console.log(`Checks: ${checks.filter((item) => item.status === 'passed').length} passed, ${checks.filter((item) => item.status === 'blocked').length} blocked`)

if (failed.length > 0) {
  console.error(`Android preflight failed: ${failed.map((item) => item.id).join(', ')}`)
  process.exit(1)
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'))
}

function firstExistingPath(paths) {
  return paths.find((path) => existsSync(path)) ?? null
}

function check(id, passed, detail, required = false) {
  return {
    id,
    status: passed ? 'passed' : 'blocked',
    required,
    detail
  }
}

function thinScriptsPythonFree(scripts) {
  return Object.entries(scripts).every(([name, value]) => !name.includes(':thin') || isPythonFreeThinScript(value))
}

function isPythonFreeThinScript(value) {
  return typeof value === 'string' && !/prepare-sidecar|\bpython\b|\buv\b/i.test(value)
}

function isAndroidThinBuildWrapper(value, kind) {
  return isPythonFreeThinScript(value)
    && value === `node ./scripts/build-android-thin-bundle.mjs --kind ${kind}`
}

function androidThinCapabilityObservable() {
  return existsSync(join(appDir, 'src-tauri/capabilities/aurora-android-thin.json'))
}

function androidThinCapabilityDetail() {
  return androidThinCapabilityObservable()
    ? 'capabilities/aurora-android-thin.json present'
    : 'capabilities/aurora-android-thin.json not present in this lane; Android-thin packaging overlay expects it from the security capability lane before actual Tauri build'
}

function androidNativePluginParity() {
  if (!generatedPluginSourceDir || !existsSync(generatedPluginSourceDir)) {
    return {
      matched: false,
      detail: generatedAndroidProject
        ? `generated Android native plugin source is missing at ${relative(generatedPluginSourceDir ?? '')}; run pnpm --filter @aurora/tauri-ui android:sync-native-plugin`
        : 'generated Android project is missing; plugin parity is checked after android:init',
      report: { checked: false, reason: generatedAndroidProject ? 'generated-plugin-source-missing' : 'generated-android-project-missing' }
    }
  }

  const canonicalFiles = sourceFiles(canonicalPluginSourceDir)
  const generatedFiles = sourceFiles(generatedPluginSourceDir)
  const canonicalRel = new Set(canonicalFiles.map((file) => pathRelative(canonicalPluginSourceDir, file)))
  const generatedRel = new Set(generatedFiles.map((file) => pathRelative(generatedPluginSourceDir, file)))
  const missing = [...canonicalRel].filter((file) => !generatedRel.has(file)).sort()
  const extra = [...generatedRel].filter((file) => !canonicalRel.has(file)).sort()
  const mismatched = [...canonicalRel]
    .filter((file) => generatedRel.has(file))
    .filter((file) => readFileSync(join(canonicalPluginSourceDir, file), 'utf8') !== readFileSync(join(generatedPluginSourceDir, file), 'utf8'))
    .sort()
  const matched = missing.length === 0 && extra.length === 0 && mismatched.length === 0
  return {
    matched,
    detail: matched
      ? `generated Android native plugin source matches canonical source (${canonicalFiles.length} files)`
      : `generated Android native plugin source is stale: missing=${missing.join(',') || 'none'}; extra=${extra.join(',') || 'none'}; mismatched=${mismatched.join(',') || 'none'}`,
    report: {
      checked: true,
      canonicalSource: relative(canonicalPluginSourceDir),
      generatedSource: relative(generatedPluginSourceDir),
      canonicalFileCount: canonicalFiles.length,
      generatedFileCount: generatedFiles.length,
      missing,
      extra,
      mismatched,
      matched
    }
  }
}

function sourceFiles(root) {
  if (!existsSync(root)) return []
  const files = []
  const stack = [root]
  while (stack.length) {
    const current = stack.pop()
    const stat = statSync(current)
    if (stat.isDirectory()) {
      for (const child of readdirSync(current)) stack.push(join(current, child))
    } else if (stat.isFile()) {
      files.push(current)
    }
  }
  return files.sort()
}

function signingInputs() {
  const configured = Boolean(
    process.env.ANDROID_KEYSTORE_PATH ||
    process.env.TAURI_ANDROID_KEYSTORE_PATH ||
    process.env.AURORA_ANDROID_SIGNING_CONFIGURED === '1'
  )
  return {
    configured,
    evidence: configured
      ? [
          envEvidence('ANDROID_KEYSTORE_PATH'),
          envEvidence('TAURI_ANDROID_KEYSTORE_PATH'),
          envEvidence('AURORA_ANDROID_SIGNING_CONFIGURED')
        ].filter(Boolean)
      : [
          'ANDROID_KEYSTORE_PATH/TAURI_ANDROID_KEYSTORE_PATH not set',
          'AURORA_ANDROID_SIGNING_CONFIGURED=1 not set',
          'preflight did not read or print secret material'
        ]
  }
}

function envEvidence(name) {
  return process.env[name] ? `${name}=set` : null
}

function assistantPayload(input) {
  return {
    id: input.id,
    platform: 'android',
    roleName: 'android.app.role.ASSISTANT',
    state: input.state,
    roleAvailable: input.roleAvailable,
    packageQualified: input.packageQualified,
    roleHeld: input.roleHeld,
    requestable: input.requestable,
    denied: input.denied,
    oemUnavailable: input.oemUnavailable,
    fallbackAvailable: input.fallbackAvailable,
    evidence: [
      `RoleManager.isRoleAvailable=${input.roleAvailable}`,
      `RoleManager.isRoleHeld=${input.roleHeld}`,
      `packageQualified=${input.packageQualified}`,
      `requestable=${input.requestable}`,
      `denied=${input.denied}`,
      `oemUnavailable=${input.oemUnavailable}`,
      `fallbackAvailable=${input.fallbackAvailable}`
    ],
    secretsRedacted: true
  }
}

function matrixRow(id, label, mode, apiLevel, architecture, expectedState, requiredEvidence) {
  return {
    id,
    label,
    mode,
    apiLevel,
    architecture,
    expectedState,
    status: 'manual',
    requiredEvidence,
    actualEvidence: ['preflight generated expected payload; device/emulator run must attach concrete logs'],
    notes: 'Use strict mode with a generated Android project and signing inputs for release readiness.'
  }
}

function relative(path) {
  return path.startsWith(repoDir) ? path.slice(repoDir.length + 1) : path
}
