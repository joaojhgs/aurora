#!/usr/bin/env node
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const repoRoot = resolve(packageRoot, '..', '..')

const args = process.argv.slice(2)
const planPath = resolve(
  readOption('--plan')
    ?? process.env.AURORA_RELEASE_ROLLBACK_PLAN_PATH
    ?? join(repoRoot, 'tools', 'voice-runtime', 'release', 'native-voice-rollback-plan.json'),
)
const reportPath = resolve(
  readOption('--report')
    ?? process.env.AURORA_RELEASE_ROLLBACK_PLAN_REPORT_PATH
    ?? join(packageRoot, 'reports', 'release-rollback-plan-policy.json'),
)
const packageJsonPath = join(packageRoot, 'package.json')
const releaseWorkflowPath = resolve(
  readOption('--workflow')
    ?? process.env.AURORA_RELEASE_WORKFLOW_PATH
    ?? join(repoRoot, '.github', 'workflows', 'release.yml'),
)

const requiredCapabilityGroups = [
  'web-local-speech',
  'desktop-native-ptt-background',
  'android-native-ptt-foreground-background-system-assistant',
  'ios-native-ptt-background',
  'native-provider-hosting',
]

const expectedCapabilityGroups = new Map([
  ['web-local-speech', {
    surface: 'web',
    capabilities: ['focused-web-speech-capture', 'focused-web-playback'],
  }],
  ['desktop-native-ptt-background', {
    surface: 'desktop',
    capabilities: ['native-push-to-talk', 'background-capture', 'desktop-playback'],
  }],
  ['android-native-ptt-foreground-background-system-assistant', {
    surface: 'android',
    capabilities: ['native-push-to-talk', 'foreground-capture', 'background-capture', 'system-assistant'],
  }],
  ['ios-native-ptt-background', {
    surface: 'ios',
    capabilities: ['native-push-to-talk', 'background-capture', 'ios-playback'],
  }],
  ['native-provider-hosting', {
    surface: 'native-provider',
    capabilities: ['local-provider-hosting', 'authorized-remote-route-hosting'],
  }],
])

const requiredOperations = [
  'withdraw-readiness',
  'cancel-capture',
  'release-capture',
  'cancel-model',
  'release-model',
  'cancel-playback',
  'release-playback',
  'restore-permitted-routes',
]

const stopOperations = new Set([
  'stop-native-provider-hosting',
  'stop-background-capture',
  'stop-model-hosting',
  'stop-playback',
])

const destructiveOperationPatterns = [
  /remove/i,
  /erase/i,
  /destroy/i,
  /drop/i,
  /clear/i,
  /purge/i,
  /delete/i,
  /wipe/i,
  /factory[-_ ]?reset/i,
  /reset[-_ ]?roles/i,
  /reset/i,
  /rewrite/i,
]

const protectedStateTermPatterns = [
  /voice/i,
  /profiles?/i,
  /cloned/i,
  /private/i,
  /credentials?/i,
  /peers?/i,
  /roles?/i,
  /user[-_ ]?data/i,
  /user[-_ ]?state/i,
  /model[-_ ]?packs?/i,
  /embeddings?/i,
  /sources?/i,
  /runtime[-_ ]?profiles?/i,
  /stable[-_ ]?(peer[-_ ]?)?ids?/i,
  /room[-_ ]?secrets?/i,
]

const requiredRejectedOperations = [
  'delete-user-data',
  'wipe-profile',
  'reset-roles',
  'clear-peer-http-credentials',
  'purge-model-packs',
  'remove-cloned-private-voice-profiles',
  'erase-voice-embeddings',
  'destroy-stable-peer-ids',
  'drop-room-secret-references',
  'rewrite-runtime-profiles',
  'enable-external-only-capabilities',
  'downgrade-webrtc-open',
]

const allowedModelPackRemovalReasons = [
  'corrupt',
  'revoked',
  'user_requested',
  'build_output_only',
]

const secretPatterns = [
  { id: 'private-key', pattern: /-----BEGIN (RSA |OPENSSH |EC |DSA |)?PRIVATE KEY-----/ },
  { id: 'bearer-credential', pattern: /\bBearer\s+[A-Za-z0-9._~+/=-]{12,}/i },
  { id: 'basic-credential', pattern: /\bBasic\s+[A-Za-z0-9+/=]{12,}/i },
  { id: 'credential-url', pattern: /\b[a-z][a-z0-9+.-]*:\/\/[^/\s:@'"]+:[^@\s/'"]+@[^/\s'"]+/i },
  { id: 'named-secret', pattern: /\b(secret|password|token|room[-_ ]?secret|peer[-_ ]?credential|credential)\s*[:=]\s*['"]?[^'"\s,}]{8,}/i },
  { id: 'api-secret', pattern: /\b(AWS_ACCESS_KEY_ID|AWS_SECRET_ACCESS_KEY|GOOGLE_APPLICATION_CREDENTIALS|OPENAI_API_KEY|ANTHROPIC_API_KEY|STRIPE_SECRET_KEY)\s*[:=]\s*['"]?[^'"\s]{12,}/i },
  { id: 'token', pattern: /\b(sk-[A-Za-z0-9_-]{20,}|ghp_[A-Za-z0-9_]{20,}|xox[baprs]-[A-Za-z0-9-]{20,})\b/ },
  { id: 'path', pattern: /(?:[A-Za-z]:\\|\/(?:Users|home|tmp|var|etc|private)\/)[^'",\s)}]+/ },
]

const sensitiveJsonKeyPatterns = [
  'roomsecret',
  'peercredential',
  'apikey',
  'accesstoken',
  'refreshtoken',
  'password',
  'secret',
  'token',
  'credential',
]

const failures = []
const report = {
  status: 'pending',
  policyId: null,
  scope: null,
  claimBoundary: null,
  runtimeProof: null,
  runtimeExecutionEvidence: false,
  runtimeE2eEvidenceClaimed: false,
  externalEvidenceRequired: null,
  planPath: redactedPath(planPath),
  packageScriptChecked: false,
  workflowChecked: false,
  checkedCapabilityGroups: [],
  checkedOperations: [],
  checkedSourceRefs: [],
  forbiddenMatches: [],
  failures: [],
  secretScanPatterns: secretPatterns.map(({ id }) => id),
  secretsRedacted: null,
}

let plan = null
try {
  const rawPlan = readFileSync(planPath, 'utf8')
  checkSecretText(rawPlan, 'plan')
  plan = JSON.parse(rawPlan)
} catch (error) {
  addFailure('plan-read', redactedPath(planPath), `could not read or parse rollback plan: ${errorMessage(error)}`)
}

try {
  if (plan) {
    checkSensitiveJsonKeys(plan)
    validatePlan(plan)
  }
} catch (error) {
  addFailure('validation-exception', 'plan', `rollback plan validation failed safely: ${errorName(error)}`)
}
validatePackageScript()
validateReleaseWorkflow()

report.status = failures.length ? 'failed' : 'passed'
report.checkedCapabilityGroups.sort()
report.checkedOperations.sort()
report.checkedSourceRefs.sort()
report.forbiddenMatches.sort((a, b) => `${a.id}:${a.location}`.localeCompare(`${b.id}:${b.location}`))
report.failures = failures.map(redacted)
report.secretsRedacted = reportHasNoRawSecrets(report)

mkdirSync(dirname(reportPath), { recursive: true })
writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`)

if (failures.length) {
  console.error(`Static release rollback policy failed. Wrote ${redactedPath(reportPath)}`)
  for (const failure of failures) console.error(`- ${failure}`)
  process.exit(1)
}

console.log(`Static release rollback policy passed. Wrote ${redactedPath(reportPath)}. Runtime rollback is not proven by this check.`)

function validatePlan(candidate) {
  if (!isRecord(candidate)) {
    addFailure('plan-shape', 'plan', 'rollback plan must be a JSON object')
    return
  }

  report.policyId = candidate.policyId === 'RAC-54-native-voice-release-rollback'
    ? 'RAC-54-native-voice-release-rollback'
    : '<invalid-policy-id>'
  validateScope(candidate.scope)
  validateCapabilityGroups(candidate.capabilityGroups)
  validateRollbackSequence(candidate.rollbackSequence, candidate.capabilityGroups)
  validateStatePreservation(candidate.statePreservation)
  validateRouteRecovery(candidate.routeRecovery)
  validateRoutePolicy(candidate.routePolicy)
  validateRejectedOperations(candidate.rejectedOperations)
}

function validateScope(scope) {
  if (!isRecord(scope)) {
    addFailure('scope-missing', 'scope', 'plan must declare policy gate scope')
    return
  }
  report.scope = scope.kind === 'policy-gate-only' ? 'policy-gate-only' : '<invalid-scope-kind>'
  report.claimBoundary = scope.claimBoundary === 'static-policy-only' ? 'static-policy-only' : '<invalid-claim-boundary>'
  report.runtimeProof = scope.runtimeProof === true
  report.runtimeExecutionEvidence = scope.runtimeExecutionEvidence === true
  report.runtimeE2eEvidenceClaimed = scope.runtimeE2eEvidenceClaimed === true
  if (scope.kind !== 'policy-gate-only') {
    addFailure('scope-kind', 'scope.kind', 'report scope must be policy-gate-only')
  }
  if (scope.claimBoundary !== 'static-policy-only') {
    addFailure('claim-boundary', 'scope.claimBoundary', 'claim boundary must be static-policy-only')
  }
  if (scope.runtimeProof !== false || scope.runtimeExecutionEvidence !== false || scope.runtimeE2eEvidenceClaimed !== false) {
    addFailure('runtime-claim', 'scope', 'policy gate must not claim runtime execution or E2E rollback evidence')
  }
  if (scope.externalEvidenceRequired !== true) {
    addFailure('external-evidence-required', 'scope.externalEvidenceRequired', 'static policy must require separate external runtime evidence')
  }
  report.externalEvidenceRequired = scope.externalEvidenceRequired === true
  const claim = stringValue(scope.reportClaim)
  if (!claim.includes('static') || !claim.includes('policy') || !claim.includes('does not prove rollback execution')) {
    addFailure('missing-scope-claim', 'scope.reportClaim', 'scope claim must state static policy-only validation and no runtime execution proof')
  }
}

function validateCapabilityGroups(groups) {
  if (!Array.isArray(groups)) {
    addFailure('capabilities-missing', 'capabilityGroups', 'capabilityGroups must be an array')
    return
  }

  const seen = new Set()
  for (const group of groups) {
    if (!isRecord(group)) {
      addFailure('capability-shape', 'capabilityGroups', 'each capability group must be an object')
      continue
    }
    const id = stringValue(group.id)
    if (!id) {
      addFailure('capability-id', 'capabilityGroups', 'capability group id is required')
      continue
    }
    if (seen.has(id)) addFailure('duplicate-capability', `capabilityGroups.${safeIdentifier(id)}`, 'capability group is duplicated')
    seen.add(id)
    const expected = expectedCapabilityGroups.get(id)
    if (expected) report.checkedCapabilityGroups.push(id)
    if (!expected) {
      addFailure('unknown-capability', `capabilityGroups.${safeIdentifier(id)}`, 'capability group is not part of RAC-54 voice rollback coverage')
    }
    if (expected && group.surface !== expected.surface) {
      addFailure('capability-surface', `capabilityGroups.${id}.surface`, `expected surface ${expected.surface}`)
    }
    const capabilities = new Set(Array.isArray(group.capabilities) ? group.capabilities.map(String) : [])
    if (!Array.isArray(group.capabilities) || group.capabilities.length === 0) {
      addFailure('capability-members', `capabilityGroups.${safeIdentifier(id)}.capabilities`, 'capability group must list covered capabilities')
    }
    if (expected) {
      for (const capability of expected.capabilities) {
        if (!capabilities.has(capability)) addFailure('capability-member-missing', `capabilityGroups.${id}.capabilities.${capability}`, 'required capability member is missing')
      }
      for (const capability of capabilities) {
        if (!expected.capabilities.includes(capability)) addFailure('capability-member-unknown', `capabilityGroups.${id}.capabilities.${safeIdentifier(capability)}`, 'capability member is not expected for this surface')
      }
    }
    if (!stringValue(group.rollbackIntent)) {
      addFailure('capability-claim', `capabilityGroups.${safeIdentifier(id)}.rollbackIntent`, 'capability group must state rollback intent')
    }
    if (expected) report.checkedSourceRefs.push(`capability:${id}`)
  }

  for (const required of requiredCapabilityGroups) {
    if (!seen.has(required)) addFailure('missing-capability', `capabilityGroups.${required}`, 'required capability group is missing')
  }
}

function validateRollbackSequence(sequence, groups) {
  if (!Array.isArray(sequence)) {
    addFailure('sequence-missing', 'rollbackSequence', 'rollbackSequence must be an array')
    return
  }
  const groupIds = new Set(Array.isArray(groups) ? groups.map((group) => isRecord(group) ? stringValue(group.id) : '') : [])
  const operationIndexes = new Map()
  const operationIds = new Set()

  for (const [index, step] of sequence.entries()) {
    if (!isRecord(step)) {
      addFailure('sequence-shape', `rollbackSequence.${index}`, 'rollback step must be an object')
      continue
    }
    const id = stringValue(step.id)
    const operation = stringValue(step.operation)
    if (!id || operationIds.has(id)) addFailure('duplicate-or-missing-step', `rollbackSequence.${index}.id`, 'rollback step ids must be unique and present')
    operationIds.add(id)
    if (!operation) addFailure('missing-operation', `rollbackSequence.${index}.operation`, 'rollback operation is required')
    if (operationIndexes.has(operation)) addFailure('duplicate-operation', `rollbackSequence.${safeIdentifier(operation)}`, 'rollback operation is duplicated')
    operationIndexes.set(operation, index)
    if (requiredOperations.includes(operation) || stopOperations.has(operation)) report.checkedOperations.push(operation)
    if (requiredRejectedOperations.includes(operation)) {
      addFailure('rejected-operation-used', `rollbackSequence.${operation}`, 'rollback sequence cannot execute a canonical rejected operation')
    }
    if (isProtectedDestructiveOperation(operation)) {
      addFailure('destructive-operation', `rollbackSequence.${safeIdentifier(operation)}`, 'destructive rollback operations cannot target protected state')
    }
    if (!Array.isArray(step.appliesTo) || step.appliesTo.length === 0) {
      addFailure('operation-coverage', `rollbackSequence.${safeIdentifier(operation)}.appliesTo`, 'rollback operation must declare affected capability groups')
    } else {
      for (const capability of step.appliesTo) {
        const capabilityId = stringValue(capability)
        if (!groupIds.has(capabilityId)) {
          addFailure('unknown-operation-capability', `rollbackSequence.${safeIdentifier(operation)}.appliesTo`, `operation references unknown capability ${safeIdentifier(capabilityId)}`)
        }
      }
    }
  }

  for (const required of requiredOperations) {
    if (!operationIndexes.has(required)) addFailure('missing-operation', `rollbackSequence.${required}`, 'required rollback operation is missing')
  }

  const readinessIndex = operationIndexes.get('withdraw-readiness')
  if (readinessIndex === undefined) {
    addFailure('missing-readiness-withdrawal', 'rollbackSequence', 'readiness withdrawal must be present before stop operations')
  } else {
    for (const operation of stopOperations) {
      const stopIndex = operationIndexes.get(operation)
      if (stopIndex !== undefined && readinessIndex > stopIndex) {
        addFailure('malformed-ordering', `rollbackSequence.${operation}`, 'readiness withdrawal must occur before stop operations')
      }
    }
  }

  assertBefore(operationIndexes, 'cancel-capture', 'release-capture')
  assertBefore(operationIndexes, 'cancel-model', 'release-model')
  assertBefore(operationIndexes, 'cancel-playback', 'release-playback')
}

function validateStatePreservation(state) {
  if (!isRecord(state)) {
    addFailure('state-preservation-missing', 'statePreservation', 'state preservation policy is required')
    return
  }
  const roles = state.roles
  if (!isRecord(roles)) {
    addFailure('role-preservation-missing', 'statePreservation.roles', 'role preservation policy is required')
  } else {
    if (roles.source !== 'saved-profile-state' || roles.preservePersistedDynamicRoles !== true) {
      addFailure('role-mutation', 'statePreservation.roles', 'dynamic roles must be preserved from saved profile state')
    }
    const forbidden = new Set(Array.isArray(roles.forbiddenSources) ? roles.forbiddenSources.map(String) : [])
    for (const source of ['env', 'build', 'apk', 'platform', 'transport', 'sidecar', 'tier']) {
      if (!forbidden.has(source)) {
        addFailure('role-source-gap', `statePreservation.roles.forbiddenSources.${source}`, 'role source mutation guard is missing')
      }
    }
  }

  const preserve = new Set(Array.isArray(state.preserve) ? state.preserve.map(String) : [])
  for (const item of [
    'runtime-profiles',
    'active-profile-id',
    'inactive-profile-ids',
    'peer-http-credentials',
    'peer-reconnect-credentials',
    'room-secret-references',
    'stable-peer-ids',
    'voice-profiles',
    'cloned-private-voice-profiles',
    'voice-profile-metadata',
    'voice-sources',
    'voice-embeddings',
    'model-pack-rollback-slots',
  ]) {
    if (!preserve.has(item)) addFailure('preservation-gap', `statePreservation.preserve.${item}`, 'required persisted state preservation is missing')
    else report.checkedSourceRefs.push(`preserve:${item}`)
  }

  const preserveUnless = new Set(isRecord(state.modelPacks) && Array.isArray(state.modelPacks.preserveUnless)
    ? state.modelPacks.preserveUnless.map(String)
    : [])
  for (const reason of allowedModelPackRemovalReasons) {
    if (!preserveUnless.has(reason)) addFailure('model-pack-policy-gap', `statePreservation.modelPacks.${reason}`, 'model pack preservation exception is missing')
  }
  for (const reason of preserveUnless) {
    if (!allowedModelPackRemovalReasons.includes(reason)) {
      addFailure('silent-deletion', `statePreservation.modelPacks.${safeIdentifier(reason)}`, 'model pack deletion reason is not allowed')
    }
  }
}

function validateRouteRecovery(routeRecovery) {
  if (!isRecord(routeRecovery)) {
    addFailure('route-recovery-missing', 'routeRecovery', 'route recovery policy is required')
    return
  }
  const expected = {
    restorePermittedPython: true,
    restoreAuthorizedRemoteRoutes: true,
    webrtcOnlyFailClosed: true,
    externalOnlyCapabilities: false,
    retainNativePttWhenOnlyMobileBackgroundWithdrawn: true,
  }
  for (const [key, value] of Object.entries(expected)) {
    if (routeRecovery[key] !== value) {
      addFailure(key === 'externalOnlyCapabilities' ? 'external-only-unsafe' : 'unsafe-downgrade', `routeRecovery.${key}`, `expected ${key} to be ${value}`)
    }
  }
}

function validateRoutePolicy(routePolicy) {
  if (!isRecord(routePolicy)) {
    addFailure('route-policy-missing', 'routePolicy', 'explicit route policy is required')
    return
  }
  const expected = {
    webrtcPreferredHttpOnlyWhenGatewayAvailable: true,
    pureWebRemoteSpeechOnlyWhenAuthorized: true,
    webrtcOnlyFailClosed: true,
    desktopLocalRemainsSeparate: true,
    retainNativePttWhenOnlyMobileBackgroundWithdrawn: true,
    externalOnlyCapabilities: false,
  }
  for (const [key, value] of Object.entries(expected)) {
    if (routePolicy[key] !== value) {
      addFailure(key === 'externalOnlyCapabilities' ? 'external-only-unsafe' : 'route-policy-unsafe', `routePolicy.${key}`, `expected ${key} to be ${value}`)
    } else {
      report.checkedSourceRefs.push(`routePolicy:${key}`)
    }
  }
}

function validateRejectedOperations(operations) {
  if (!Array.isArray(operations)) {
    addFailure('rejected-operations-missing', 'rejectedOperations', 'rejected destructive operation list is required')
    return
  }
  const rejected = new Set(operations.map(String))
  for (const required of requiredRejectedOperations) {
    if (!rejected.has(required)) addFailure('rejected-operation-gap', `rejectedOperations.${required}`, 'canonical rejected-operation protection is missing')
    else report.checkedSourceRefs.push(`rejected:${required}`)
  }
  for (const operation of operations) {
    const value = stringValue(operation)
    if (requiredRejectedOperations.includes(value)) report.checkedOperations.push(`reject:${value}`)
    if (value && !requiredRejectedOperations.includes(value)) {
      addFailure('rejected-operation-claim', `rejectedOperations.${safeIdentifier(value)}`, 'rejected operation is not part of the canonical protection set')
    }
  }
}

function validatePackageScript() {
  let packageJson
  try {
    packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf8'))
  } catch (error) {
    addFailure('package-wiring-read', redactedPath(packageJsonPath), `could not read package script wiring: ${errorMessage(error)}`)
    return
  }
  const script = packageJson?.scripts?.['verify:static-release-rollback-policy']
  if (script !== 'node ./scripts/assert-release-rollback-plan.mjs') {
    addFailure('package-script-wiring', 'apps/aurora-tauri/package.json', 'verify:static-release-rollback-policy must invoke assert-release-rollback-plan.mjs')
    return
  }
  report.packageScriptChecked = true
  report.checkedSourceRefs.push('package:verify:static-release-rollback-policy')
}

function validateReleaseWorkflow() {
  let workflow
  try {
    workflow = readFileSync(releaseWorkflowPath, 'utf8')
  } catch (error) {
    addFailure('workflow-wiring-read', redactedPath(releaseWorkflowPath), `could not read release workflow wiring: ${errorMessage(error)}`)
    return
  }
  const lines = workflow.split(/\r?\n/)
  const readinessStart = findLine(lines, /^\s*-\s+name:\s+Run lightweight release check\s*$/)
  const semverStart = findLine(lines, /^\s*-\s+name:\s+Check next semantic version\s*$/)
  const uploadStart = findLine(lines, /^\s*-\s+name:\s+Upload static release rollback policy report\s*$/)
  const commandLine = findLine(lines, /^\s*pnpm --filter @aurora\/tauri-ui verify:static-release-rollback-policy\s*$/)
  const uploadIfLine = findLine(lines, /^\s*if:\s+always\(\)\s*$/)
  const uploadUsesLine = findLine(lines, /^\s*uses:\s+actions\/upload-artifact@v4\s*$/)
  const uploadPathLine = findLine(lines, /^\s*path:\s+apps\/aurora-tauri\/reports\/release-rollback-plan-policy\.json\s*$/)

  if (readinessStart === -1 || semverStart === -1 || uploadStart === -1) {
    addFailure('workflow-wiring', '.github/workflows/release.yml', 'release workflow must contain readiness, report upload, and semver steps')
    return
  }
  const nextStepAfterReadiness = findNextStepLine(lines, readinessStart + 1)
  if (commandLine === -1 || commandLine <= readinessStart || commandLine >= nextStepAfterReadiness) {
    addFailure('workflow-wiring', '.github/workflows/release.yml', 'static policy command must run inside the release readiness check step')
  }
  if (commandLine > semverStart) {
    addFailure('workflow-ordering', '.github/workflows/release.yml', 'static policy command must run before semantic versioning')
  }
  if (uploadStart <= commandLine || uploadStart >= semverStart) {
    addFailure('workflow-ordering', '.github/workflows/release.yml', 'static policy report upload must be after readiness and before semantic versioning')
  }
  const nextStepAfterUpload = findNextStepLine(lines, uploadStart + 1)
  for (const [line, label] of [
    [uploadIfLine, 'if: always()'],
    [uploadUsesLine, 'actions/upload-artifact@v4'],
    [uploadPathLine, 'report path'],
  ]) {
    if (line === -1 || line <= uploadStart || line >= nextStepAfterUpload) {
      addFailure('workflow-wiring', '.github/workflows/release.yml', `static policy report upload step is missing ${label}`)
    }
  }
  if (!failures.some((failure) => failure.includes('workflow-'))) {
    report.workflowChecked = true
    report.checkedSourceRefs.push('workflow:release-readiness-static-policy')
  }
}

function assertBefore(operationIndexes, before, after) {
  if (!operationIndexes.has(before) || !operationIndexes.has(after)) return
  if (operationIndexes.get(before) > operationIndexes.get(after)) {
    addFailure('malformed-ordering', `rollbackSequence.${before}.${after}`, `${before} must occur before ${after}`)
  }
}

function checkSecretText(text, location) {
  for (const { id, pattern } of secretPatterns) {
    if (pattern.test(text)) {
      report.forbiddenMatches.push({ id, location })
      addFailure('secret-leakage', location, `rollback plan contains ${id}`)
    }
  }
}

function checkSensitiveJsonKeys(value) {
  if (Array.isArray(value)) {
    for (const item of value) checkSensitiveJsonKeys(item)
    return
  }
  if (!isRecord(value)) return
  for (const [key, child] of Object.entries(value)) {
    const normalizedKey = normalizeJsonKey(key)
    if (sensitiveJsonKeyPatterns.some((pattern) => normalizedKey.includes(pattern))) {
      report.forbiddenMatches.push({ id: 'sensitive-json-key', location: '<json-field>' })
      addFailure('sensitive-json-key', 'plan', 'rollback plan contains a sensitive JSON field')
    }
    checkSensitiveJsonKeys(child)
  }
}

function addFailure(id, location, detail) {
  failures.push(`${id} at ${redacted(location)}: ${redacted(detail)}`)
}

function isProtectedDestructiveOperation(operation) {
  return destructiveOperationPatterns.some((pattern) => pattern.test(operation))
    && protectedStateTermPatterns.some((pattern) => pattern.test(operation))
}

function safeIdentifier(value) {
  const text = redacted(value)
  if (/^[A-Za-z0-9_.:-]+$/.test(text) && text.length <= 96) return text
  return '<invalid>'
}

function findLine(lines, pattern) {
  return lines.findIndex((line) => {
    const trimmed = line.trim()
    return trimmed !== '' && !trimmed.startsWith('#') && pattern.test(line)
  })
}

function findNextStepLine(lines, start) {
  const index = lines.findIndex((line, offset) => offset >= start && /^\s*-\s+name:\s+/.test(line))
  return index === -1 ? lines.length : index
}

function readOption(name) {
  const index = args.indexOf(name)
  return index === -1 ? null : args[index + 1]
}

function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function stringValue(value) {
  return typeof value === 'string' ? value : ''
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error)
}

function errorName(error) {
  return error instanceof Error ? error.name : 'UnknownError'
}

function redactedPath(path) {
  const relativePath = normalizePath(relative(repoRoot, path))
  if (relativePath && !relativePath.startsWith('..') && !relativePath.startsWith('/')) return relativePath
  return redacted(path)
}

function redacted(value) {
  return String(value)
    .replaceAll(normalizePath(repoRoot), '<repo>')
    .replaceAll(normalizePath(packageRoot), '<package>')
    .replaceAll(normalizePath(process.cwd()), '<cwd>')
    .replaceAll(normalizePath(tmpdir()), '<tmp>')
    .replace(/\b[a-z][a-z0-9+.-]*:\/\/[^/\s:@'"]+:[^@\s/'"]+@[^/\s'"]+/gi, '<redacted-url>')
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, 'Bearer <redacted>')
    .replace(/\bBasic\s+[A-Za-z0-9+/=]{8,}/gi, 'Basic <redacted>')
    .replace(/\b(secret|password|token|room[-_ ]?secret|peer[-_ ]?credential|credential)\s*[:=]\s*['"]?[^'"\s,}]+/gi, '$1=<redacted>')
    .replace(/(?:[A-Za-z]:\\|\/(?:Users|home|tmp|var|etc|private)\/)[^'",\s)}]+/g, '<redacted-path>')
    .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/g, '<redacted-token>')
    .replace(/\bghp_[A-Za-z0-9_]{8,}\b/g, '<redacted-token>')
    .replace(/\bxox[baprs]-[A-Za-z0-9-]{8,}\b/g, '<redacted-token>')
    .replace(/\b(AWS_SECRET_ACCESS_KEY|OPENAI_API_KEY|ANTHROPIC_API_KEY|STRIPE_SECRET_KEY)\s*[:=]\s*['"]?[^'"\s]+/gi, '$1=<redacted>')
}

function reportHasNoRawSecrets(candidateReport) {
  const text = JSON.stringify(candidateReport)
  return secretPatterns.every(({ pattern }) => !pattern.test(text))
}

function normalizeJsonKey(key) {
  return String(key).replace(/[^A-Za-z0-9]/g, '').toLowerCase()
}

function normalizePath(path) {
  return String(path).replaceAll('\\', '/')
}
