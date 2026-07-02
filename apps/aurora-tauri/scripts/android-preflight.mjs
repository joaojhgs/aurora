#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
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
const generatedAndroidProject = firstExistingPath([
  join(appDir, 'src-tauri/gen/android'),
  join(appDir, 'gen/android')
])
const signingEvidence = signingInputs()
const expectedCommands = {
  aab: 'pnpm --filter @aurora/tauri-ui tauri android build --aab',
  apk: 'pnpm --filter @aurora/tauri-ui tauri android build --apk --split-per-abi'
}

const checks = [
  check('tauri-cli-script', Boolean(packageJson.scripts?.tauri), 'package exposes the Tauri CLI script'),
  check('android-aab-command-documented', true, expectedCommands.aab),
  check('android-apk-command-documented', true, expectedCommands.apk),
  check(
    'generated-android-project',
    Boolean(generatedAndroidProject),
    generatedAndroidProject
      ? `generated Android project found at ${relative(generatedAndroidProject)}`
      : 'run pnpm --filter @aurora/tauri-ui tauri android init before strict release builds',
    requireAndroidProject
  ),
  check('bundle-identifier', Boolean(tauriConfig.identifier), tauriConfig.identifier ?? 'missing identifier', true),
  check('bundle-version', Boolean(tauriConfig.version), tauriConfig.version ?? 'missing version', true),
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
