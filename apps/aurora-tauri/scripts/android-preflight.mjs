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
const canonicalPluginResourceDir = join(appDir, 'src-tauri/android/aurora-native-plugin/src/main/res')
const generatedPluginSourceDir = generatedAndroidProject
  ? join(generatedAndroidProject, 'app/src/main/java/dev/aurora/tauri/nativeplugin')
  : null
const generatedPluginResourceDir = generatedAndroidProject
  ? join(generatedAndroidProject, 'app/src/main/res')
  : null
const generatedManifestPath = generatedAndroidProject
  ? join(generatedAndroidProject, 'app/src/main/AndroidManifest.xml')
  : null
const generatedTauriSettingsPath = generatedAndroidProject
  ? join(generatedAndroidProject, 'tauri.settings.gradle')
  : null
const vendorBarcodeScannerDir = join(
  appDir,
  'src-tauri/vendor/tauri-plugin-barcode-scanner'
)
const vendorBarcodeScannerSourcePath = join(
  vendorBarcodeScannerDir,
  'android/src/main/java/BarcodeScannerPlugin.kt'
)
const vendorBarcodeScannerBuildScriptPath = join(vendorBarcodeScannerDir, 'build.rs')
const pluginParity = androidNativePluginParity()
const resourceParity = androidNativeResourceParity()
const manifestIntegration = androidNativeManifestIntegration()
const barcodeScannerCancellation = androidBarcodeScannerCancellationIntegration()
const signingEvidence = signingInputs()
const expectedCommands = {
  prepareClient: 'pnpm --filter @aurora/tauri-ui android:prepare:client',
  prepareThinAlias: 'pnpm --filter @aurora/tauri-ui android:prepare:thin',
  apk: 'pnpm --filter @aurora/tauri-ui android:build:client:apk',
  apkThinAlias: 'pnpm --filter @aurora/tauri-ui android:build:thin:apk',
  verifyApk: 'pnpm --filter @aurora/tauri-ui android:verify:client:apk',
  verifyApkThinAlias: 'pnpm --filter @aurora/tauri-ui android:verify:thin:apk',
  aab: 'pnpm --filter @aurora/tauri-ui android:build:client:aab',
  aabThinAlias: 'pnpm --filter @aurora/tauri-ui android:build:thin:aab',
  verifyAab: 'pnpm --filter @aurora/tauri-ui android:verify:client:aab',
  verifyAabThinAlias: 'pnpm --filter @aurora/tauri-ui android:verify:thin:aab'
}

const checks = [
  check('tauri-cli-script', Boolean(packageJson.scripts?.tauri), 'package exposes the Tauri CLI script'),
  check('android-client-prepare-command', packageJson.scripts?.['android:prepare:client'] === 'node ./scripts/prepare-android-client-bundle.mjs', packageJson.scripts?.['android:prepare:client'] ?? 'missing'),
  check('android-thin-prepare-alias', packageJson.scripts?.['android:prepare:thin'] === 'pnpm android:prepare:client', packageJson.scripts?.['android:prepare:thin'] ?? 'missing'),
  check('android-client-apk-command', isAndroidClientBuildWrapper(packageJson.scripts?.['android:build:client:apk'], 'apk'), packageJson.scripts?.['android:build:client:apk'] ?? 'missing'),
  check('android-thin-apk-alias', packageJson.scripts?.['android:build:thin:apk'] === 'pnpm android:build:client:apk', packageJson.scripts?.['android:build:thin:apk'] ?? 'missing'),
  check('android-client-apk-arm64-command', packageJson.scripts?.['android:build:client:apk:arm64'] === 'node ./scripts/build-android-client-bundle.mjs --kind apk --target aarch64', packageJson.scripts?.['android:build:client:apk:arm64'] ?? 'missing'),
  check('android-thin-apk-arm64-alias', packageJson.scripts?.['android:build:thin:apk:arm64'] === 'pnpm android:build:client:apk:arm64', packageJson.scripts?.['android:build:thin:apk:arm64'] ?? 'missing'),
  check('android-client-apk-x86_64-command', packageJson.scripts?.['android:build:client:apk:x86_64'] === 'node ./scripts/build-android-client-bundle.mjs --kind apk --target x86_64', packageJson.scripts?.['android:build:client:apk:x86_64'] ?? 'missing'),
  check('android-thin-apk-x86_64-alias', packageJson.scripts?.['android:build:thin:apk:x86_64'] === 'pnpm android:build:client:apk:x86_64', packageJson.scripts?.['android:build:thin:apk:x86_64'] ?? 'missing'),
  check('android-client-aab-command', isAndroidClientBuildWrapper(packageJson.scripts?.['android:build:client:aab'], 'aab'), packageJson.scripts?.['android:build:client:aab'] ?? 'missing'),
  check('android-thin-aab-alias', packageJson.scripts?.['android:build:thin:aab'] === 'pnpm android:build:client:aab', packageJson.scripts?.['android:build:thin:aab'] ?? 'missing'),
  check('android-client-apk-proof-command', packageJson.scripts?.['android:verify:client:apk']?.includes('assert-android-client-artifact-clean.mjs --kind apk'), packageJson.scripts?.['android:verify:client:apk'] ?? 'missing'),
  check('android-thin-apk-proof-alias', packageJson.scripts?.['android:verify:thin:apk'] === 'pnpm android:verify:client:apk', packageJson.scripts?.['android:verify:thin:apk'] ?? 'missing'),
  check('android-client-aab-proof-command', packageJson.scripts?.['android:verify:client:aab']?.includes('assert-android-client-artifact-clean.mjs --kind aab'), packageJson.scripts?.['android:verify:client:aab'] ?? 'missing'),
  check('android-thin-aab-proof-alias', packageJson.scripts?.['android:verify:thin:aab'] === 'pnpm android:verify:client:aab', packageJson.scripts?.['android:verify:thin:aab'] ?? 'missing'),
  check('android-client-and-thin-scripts-python-free', clientAndThinScriptsPythonFree(packageJson.scripts ?? {}), 'all *:client and *:thin scripts avoid uv/python/prepare-sidecar'),
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
  check(
    'android-native-resource-parity',
    resourceParity.matched,
    resourceParity.detail,
    Boolean(generatedAndroidProject)
  ),
  check(
    'android-native-manifest-integration',
    manifestIntegration.matched,
    manifestIntegration.detail,
    Boolean(generatedAndroidProject)
  ),
  check(
    'android-barcode-scanner-cancellation',
    barcodeScannerCancellation.matched,
    barcodeScannerCancellation.detail,
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
  nativeResourceParity: resourceParity.report,
  nativeManifestIntegration: manifestIntegration.report,
  barcodeScannerCancellation: barcodeScannerCancellation.report,
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

function clientAndThinScriptsPythonFree(scripts) {
  return Object.entries(scripts).every(([name, value]) => {
    if (!name.includes(':thin') && !name.includes(':client')) return true
    return isPythonFreeScript(value)
  })
}

function isPythonFreeScript(value) {
  return typeof value === 'string' && !/prepare-sidecar|\bpython\b|\buv\b/i.test(value)
}

function isAndroidClientBuildWrapper(value, kind) {
  return isPythonFreeScript(value)
    && value === `node ./scripts/build-android-client-bundle.mjs --kind ${kind}`
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

function androidNativeResourceParity() {
  if (!generatedPluginResourceDir || !existsSync(generatedPluginResourceDir)) {
    return {
      matched: false,
      detail: generatedAndroidProject
        ? `generated Android native resources are missing at ${relative(generatedPluginResourceDir ?? '')}; run pnpm --filter @aurora/tauri-ui android:sync-native-plugin`
        : 'generated Android project is missing; native resource parity is checked after android:init',
      report: {
        checked: false,
        reason: generatedAndroidProject
          ? 'generated-plugin-resources-missing'
          : 'generated-android-project-missing'
      }
    }
  }

  const canonicalFiles = sourceFiles(canonicalPluginResourceDir)
  const missing = []
  const mismatched = []
  for (const canonicalFile of canonicalFiles) {
    const rel = pathRelative(canonicalPluginResourceDir, canonicalFile)
    const generatedRel = rel === join('values', 'strings.xml')
      ? join('values', 'aurora_native_strings.xml')
      : rel
    const generatedFile = join(generatedPluginResourceDir, generatedRel)
    if (!existsSync(generatedFile)) {
      missing.push(generatedRel)
    } else if (!readFileSync(canonicalFile).equals(readFileSync(generatedFile))) {
      mismatched.push(generatedRel)
    }
  }
  const matched = missing.length === 0 && mismatched.length === 0
  return {
    matched,
    detail: matched
      ? `generated Android native resources match canonical resources (${canonicalFiles.length} files)`
      : `generated Android native resources are stale: missing=${missing.join(',') || 'none'}; mismatched=${mismatched.join(',') || 'none'}`,
    report: {
      checked: true,
      canonicalSource: relative(canonicalPluginResourceDir),
      generatedSource: relative(generatedPluginResourceDir),
      fileCount: canonicalFiles.length,
      missing,
      mismatched
    }
  }
}

function androidNativeManifestIntegration() {
  if (!generatedManifestPath || !existsSync(generatedManifestPath)) {
    return {
      matched: false,
      detail: generatedAndroidProject
        ? `generated Android manifest is missing at ${relative(generatedManifestPath ?? '')}; run pnpm --filter @aurora/tauri-ui android:sync-native-plugin`
        : 'generated Android project is missing; native manifest integration is checked after android:init',
      report: {
        checked: false,
        reason: generatedAndroidProject
          ? 'generated-android-manifest-missing'
          : 'generated-android-project-missing'
      }
    }
  }

  const manifest = readFileSync(generatedManifestPath, 'utf8')
  const required = [
    'android.permission.INTERNET',
    'android.permission.ACCESS_NETWORK_STATE',
    'android.permission.RECORD_AUDIO',
    'android.permission.MODIFY_AUDIO_SETTINGS',
    'android.permission.POST_NOTIFICATIONS',
    'android.permission.FOREGROUND_SERVICE',
    'android.permission.FOREGROUND_SERVICE_MICROPHONE',
    'android.permission.USE_BIOMETRIC',
    'dev.aurora.tauri.nativeplugin.AuroraVoiceForegroundService',
    'dev.aurora.tauri.nativeplugin.AuroraVoiceInteractionService',
    'dev.aurora.tauri.nativeplugin.AuroraVoiceInteractionSessionService',
    'dev.aurora.tauri.nativeplugin.AuroraAssistActivity',
    'dev.aurora.tauri.nativeplugin.AuroraEntrypointActivity',
    'dev.aurora.tauri.nativeplugin.AuroraWidgetProvider',
    'dev.aurora.tauri.nativeplugin.AuroraQuickSettingsTileService',
    'android:scheme="aurora" android:host="mesh"',
    '@xml/aurora_voice_interaction_service',
    '@xml/aurora_shortcuts',
    '@xml/aurora_widget_info'
  ]
  const missing = required.filter((entry) => !manifest.includes(entry))
  return {
    matched: missing.length === 0,
    detail: missing.length === 0
      ? `generated Android manifest includes ${required.length} required Aurora permission/component declarations`
      : `generated Android manifest is missing: ${missing.join(', ')}`,
    report: {
      checked: true,
      manifest: relative(generatedManifestPath),
      requiredCount: required.length,
      missing
    }
  }
}

function androidBarcodeScannerCancellationIntegration() {
  if (
    !existsSync(vendorBarcodeScannerSourcePath) ||
    !existsSync(vendorBarcodeScannerBuildScriptPath)
  ) {
    return {
      matched: false,
      detail: generatedAndroidProject
        ? 'vendored Android barcode cancellation integration is missing; run pnpm --filter @aurora/tauri-ui android:sync-native-plugin'
        : 'generated Android project is missing; barcode cancellation integration is checked after android:init',
      report: {
        checked: false,
        reason: generatedAndroidProject
          ? 'vendor-barcode-cancellation-integration-missing'
          : 'generated-android-project-missing'
      }
    }
  }

  const source = readFileSync(vendorBarcodeScannerSourcePath, 'utf8')
  const requiredSource = [
    'val pendingScan = savedInvoke',
    'destroy()',
    'pendingScan?.reject("cancelled")',
    'invoke.resolve()'
  ]
  const missing = requiredSource.filter((entry) => !source.includes(entry))
  const cargoToml = readFileSync(join(appDir, 'src-tauri/Cargo.toml'), 'utf8')
  const dependencyUsesVendor = cargoToml.includes(
    'tauri-plugin-barcode-scanner = { path = "vendor/tauri-plugin-barcode-scanner" }'
  )
  const buildScriptUsesAndroidPath = readFileSync(
    vendorBarcodeScannerBuildScriptPath,
    'utf8'
  ).includes('.android_path("android")')
  const settingsExists = Boolean(
    generatedTauriSettingsPath && existsSync(generatedTauriSettingsPath)
  )
  const settingsUseVendor = settingsExists
    ? readFileSync(generatedTauriSettingsPath, 'utf8').includes(
        resolve(vendorBarcodeScannerDir, 'android')
      )
    : null
  const matched = missing.length === 0
    && dependencyUsesVendor
    && buildScriptUsesAndroidPath
    && (settingsUseVendor ?? true)
  return {
    matched,
    detail: matched
      ? settingsExists
        ? 'generated Android build uses the cancellation-safe vendored barcode scanner source'
        : 'Tauri mobile build will generate Android Gradle plugin bindings from the cancellation-safe vendored barcode scanner source'
      : `Android barcode cancellation integration is stale: missing=${missing.join(', ') || 'none'}; dependencyUsesVendor=${dependencyUsesVendor}; buildScriptUsesAndroidPath=${buildScriptUsesAndroidPath}; settingsUseVendor=${settingsUseVendor ?? 'pending-tauri-build'}`,
    report: {
      checked: true,
      source: relative(vendorBarcodeScannerSourcePath),
      buildScript: relative(vendorBarcodeScannerBuildScriptPath),
      settings: settingsExists ? relative(generatedTauriSettingsPath) : null,
      missing,
      dependencyUsesVendor,
      buildScriptUsesAndroidPath,
      settingsUseVendor,
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
