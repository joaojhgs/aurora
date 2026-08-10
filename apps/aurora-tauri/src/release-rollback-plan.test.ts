// @vitest-environment node

import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const repoRoot = resolve(packageRoot, '..', '..')
const script = join(packageRoot, 'scripts', 'assert-release-rollback-plan.mjs')
const canonicalPlan = join(repoRoot, 'tools', 'voice-runtime', 'release', 'native-voice-rollback-plan.json')
const releaseWorkflow = join(repoRoot, '.github', 'workflows', 'release.yml')

interface RollbackPlan {
  policyId: string
  version: number
  scope: {
    kind: string
    runtimeExecutionEvidence: boolean
    runtimeE2eEvidenceClaimed: boolean
    reportClaim: string
    claimBoundary: string
    runtimeProof: boolean
    externalEvidenceRequired: boolean
  }
  capabilityGroups: Array<{
    id: string
    surface: string
    capabilities: string[]
    rollbackIntent: string
  }>
  rollbackSequence: Array<{
    id: string
    operation: string
    appliesTo: string[]
    requiredBefore?: string[]
  }>
  statePreservation: {
    roles: {
      source: string
      preservePersistedDynamicRoles: boolean
      forbiddenSources: string[]
    }
    preserve: string[]
    modelPacks: {
      preserveUnless: string[]
    }
  }
  routeRecovery: {
    restorePermittedPython: boolean
    restoreAuthorizedRemoteRoutes: boolean
    webrtcOnlyFailClosed: boolean
    externalOnlyCapabilities: boolean
    retainNativePttWhenOnlyMobileBackgroundWithdrawn: boolean
  }
  routePolicy: {
    webrtcPreferredHttpOnlyWhenGatewayAvailable: boolean
    pureWebRemoteSpeechOnlyWhenAuthorized: boolean
    webrtcOnlyFailClosed: boolean
    desktopLocalRemainsSeparate: boolean
    retainNativePttWhenOnlyMobileBackgroundWithdrawn: boolean
    externalOnlyCapabilities: boolean
  }
  rejectedOperations: string[]
}

interface PolicyContext {
  root: string
  planPath: string
  reportPath: string
}

function createContext(plan: RollbackPlan = readCanonicalPlan()): PolicyContext {
  const root = mkdtempSync(join(tmpdir(), 'aurora-release-rollback-plan-'))
  const planPath = join(root, 'native-voice-rollback-plan.json')
  const reportPath = join(root, 'release-rollback-plan-policy.json')
  mkdirSync(root, { recursive: true })
  writeFileSync(planPath, `${JSON.stringify(plan, null, 2)}\n`)
  return { root, planPath, reportPath }
}

function readCanonicalPlan(): RollbackPlan {
  return JSON.parse(readFileSync(canonicalPlan, 'utf8')) as RollbackPlan
}

function runPolicy(context: PolicyContext) {
  return spawnSync(process.execPath, [
    script,
    '--plan',
    context.planPath,
    '--report',
    context.reportPath,
  ], {
    cwd: packageRoot,
    encoding: 'utf8',
  })
}

function runPolicyWithWorkflow(context: PolicyContext, workflowPath: string) {
  return spawnSync(process.execPath, [
    script,
    '--plan',
    context.planPath,
    '--report',
    context.reportPath,
    '--workflow',
    workflowPath,
  ], {
    cwd: packageRoot,
    encoding: 'utf8',
  })
}

function runCanonicalPolicy(reportPath: string) {
  return spawnSync(process.execPath, [
    script,
    '--report',
    reportPath,
  ], {
    cwd: packageRoot,
    encoding: 'utf8',
  })
}

function runPackageScript(reportPath: string) {
  return spawnSync('pnpm', ['--filter', '@aurora/tauri-ui', 'verify:static-release-rollback-policy'], {
    cwd: repoRoot,
    encoding: 'utf8',
    env: {
      ...process.env,
      AURORA_RELEASE_ROLLBACK_PLAN_REPORT_PATH: reportPath,
    },
  })
}

describe('RAC-54 release rollback plan policy gate', () => {
  it('validates the canonical rollback plan directly without claiming runtime E2E proof', () => {
    const root = mkdtempSync(join(tmpdir(), 'aurora-release-rollback-plan-canonical-'))
    const reportPath = join(root, 'release-rollback-plan-policy.json')

    const result = runCanonicalPolicy(reportPath)

    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout).toContain('Static release rollback policy passed')
    const report = JSON.parse(readFileSync(reportPath, 'utf8')) as {
      scope: string
      runtimeExecutionEvidence: boolean
      runtimeE2eEvidenceClaimed: boolean
      runtimeProof: boolean
      claimBoundary: string
      externalEvidenceRequired: boolean
      checkedCapabilityGroups: string[]
      checkedOperations: string[]
      checkedSourceRefs: string[]
      forbiddenMatches: unknown[]
      secretsRedacted: boolean
    }
    expect(report).toMatchObject({
      scope: 'policy-gate-only',
      claimBoundary: 'static-policy-only',
      runtimeProof: false,
      runtimeExecutionEvidence: false,
      runtimeE2eEvidenceClaimed: false,
      externalEvidenceRequired: true,
      secretsRedacted: true,
    })
    expect(report.checkedCapabilityGroups).toEqual([
      'android-native-ptt-foreground-background-system-assistant',
      'desktop-native-ptt-background',
      'ios-native-ptt-background',
      'native-provider-hosting',
      'web-local-speech',
    ])
    expect(report.checkedOperations).toEqual(expect.arrayContaining([
      'withdraw-readiness',
      'cancel-capture',
      'release-capture',
      'cancel-model',
      'release-model',
      'cancel-playback',
      'release-playback',
      'restore-permitted-routes',
    ]))
    expect(report.checkedSourceRefs).toEqual(expect.arrayContaining([
      'capability:web-local-speech',
      'preserve:active-profile-id',
      'preserve:inactive-profile-ids',
      'preserve:peer-reconnect-credentials',
      'preserve:room-secret-references',
      'preserve:stable-peer-ids',
      'preserve:cloned-private-voice-profiles',
      'preserve:voice-profile-metadata',
      'preserve:model-pack-rollback-slots',
      'package:verify:static-release-rollback-policy',
      'workflow:release-readiness-static-policy',
    ]))
    expect(report.forbiddenMatches).toEqual([])
  })

  it('rejects missing, duplicate, and unknown capability groups', () => {
    const plan = readCanonicalPlan()
    const duplicateGroup = plan.capabilityGroups.find((group) => group.id === 'desktop-native-ptt-background')
    if (!duplicateGroup) throw new Error('canonical plan missing desktop-native-ptt-background fixture')
    plan.capabilityGroups = [
      ...plan.capabilityGroups.filter((group) => group.id !== 'web-local-speech'),
      { ...duplicateGroup },
      { ...plan.capabilityGroups[0], id: 'sidecar-runtime-tier' },
    ]
    const context = createContext(plan)

    const result = runPolicy(context)

    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('missing-capability')
    expect(result.stderr).toContain('duplicate-capability')
    expect(result.stderr).toContain('unknown-capability')
  })

  it('rejects wrong surfaces and missing required capability members', () => {
    const plan = readCanonicalPlan()
    plan.capabilityGroups = plan.capabilityGroups.map((group) => {
      if (group.id === 'web-local-speech') {
        return { ...group, surface: 'desktop', capabilities: ['focused-web-speech-capture'] }
      }
      if (group.id === 'android-native-ptt-foreground-background-system-assistant') {
        return { ...group, capabilities: ['native-push-to-talk', 'foreground-capture'] }
      }
      if (group.id === 'ios-native-ptt-background') {
        return { ...group, capabilities: ['background-capture'] }
      }
      if (group.id === 'native-provider-hosting') {
        return { ...group, capabilities: ['local-provider-hosting'] }
      }
      return group
    })
    const context = createContext(plan)

    const result = runPolicy(context)

    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('capability-surface')
    expect(result.stderr).toContain('focused-web-playback')
    expect(result.stderr).toContain('background-capture')
    expect(result.stderr).toContain('system-assistant')
    expect(result.stderr).toContain('native-push-to-talk')
    expect(result.stderr).toContain('authorized-remote-route-hosting')
  })

  it('rejects malformed rollback ordering and missing release/cancellation claims', () => {
    const plan = readCanonicalPlan()
    const withoutCancelModel = plan.rollbackSequence.filter((step) => step.operation !== 'cancel-model')
    const stopIndex = withoutCancelModel.findIndex((step) => step.operation === 'stop-native-provider-hosting')
    const readinessIndex = withoutCancelModel.findIndex((step) => step.operation === 'withdraw-readiness')
    const reordered = [...withoutCancelModel]
    const [readiness] = reordered.splice(readinessIndex, 1)
    reordered.splice(stopIndex, 0, readiness)
    plan.rollbackSequence = reordered
    const context = createContext(plan)

    const result = runPolicy(context)

    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('malformed-ordering')
    expect(result.stderr).toContain('missing-operation')
  })

  it('rejects role mutation away from saved profile state', () => {
    const plan = readCanonicalPlan()
    plan.statePreservation = {
      ...plan.statePreservation,
      roles: {
        ...plan.statePreservation.roles,
        source: 'platform',
        preservePersistedDynamicRoles: false,
        forbiddenSources: plan.statePreservation.roles.forbiddenSources.filter((source) => source !== 'apk'),
      },
    }
    const context = createContext(plan)

    const result = runPolicy(context)

    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('role-mutation')
    expect(result.stderr).toContain('role-source-gap')
  })

  it('rejects env, build, and sidecar-as-client role source mistakes', () => {
    for (const source of ['env', 'build', 'sidecar']) {
      const plan = readCanonicalPlan()
      plan.statePreservation = {
        ...plan.statePreservation,
        roles: {
          ...plan.statePreservation.roles,
          source,
        },
      }
      const context = createContext(plan)

      const result = runPolicy(context)

      expect(result.status).not.toBe(0)
      expect(result.stderr).toContain('role-mutation')
    }
  })

  it('rejects unsafe route downgrades, external-only capability enablement, and native PTT withdrawal coupling', () => {
    const plan = readCanonicalPlan()
    plan.routeRecovery = {
      ...plan.routeRecovery,
      restorePermittedPython: false,
      restoreAuthorizedRemoteRoutes: false,
      webrtcOnlyFailClosed: false,
      externalOnlyCapabilities: true,
      retainNativePttWhenOnlyMobileBackgroundWithdrawn: false,
    }
    const context = createContext(plan)

    const result = runPolicy(context)

    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('unsafe-downgrade')
    expect(result.stderr).toContain('external-only-unsafe')
  })

  it('rejects silent model pack deletion reasons', () => {
    const plan = readCanonicalPlan()
    plan.statePreservation = {
      ...plan.statePreservation,
      modelPacks: {
        preserveUnless: ['corrupt', 'revoked', 'user_requested', 'build_output_only', 'inactive'],
      },
    }
    const context = createContext(plan)

    const result = runPolicy(context)

    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('silent-deletion')
  })

  it('rejects destructive operations and still writes a redacted report', () => {
    const plan = readCanonicalPlan()
    plan.rollbackSequence = [
      ...plan.rollbackSequence,
      {
        id: 'wipe-profile',
        operation: 'wipe-profile-with-OPENAI_API_KEY=sk-123456789012345678901234',
        appliesTo: ['desktop-native-ptt-background'],
      },
    ]
    const context = createContext(plan)

    const result = runPolicy(context)

    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('destructive-operation')
    expect(result.stderr).not.toContain('sk-123456789012345678901234')
    expect(result.stderr).not.toContain(context.root)
    const reportText = readFileSync(context.reportPath, 'utf8')
    expect(reportText).not.toContain('sk-123456789012345678901234')
    expect(reportText).not.toContain(context.root)
    expect(JSON.parse(reportText)).toMatchObject({ secretsRedacted: true })
  })

  it('rejects protected destructive operation verbs beyond delete and wipe', () => {
    const plan = readCanonicalPlan()
    plan.rollbackSequence = [
      ...plan.rollbackSequence,
      {
        id: 'remove-cloned-private-voice-profiles',
        operation: 'remove-cloned-private-voice-profiles',
        appliesTo: ['ios-native-ptt-background'],
      },
      {
        id: 'drop-room-secret-references',
        operation: 'drop-room-secret-references',
        appliesTo: ['native-provider-hosting'],
      },
      {
        id: 'rewrite-runtime-profiles',
        operation: 'rewrite-runtime-profiles',
        appliesTo: ['desktop-native-ptt-background'],
      },
    ]
    const context = createContext(plan)

    const result = runPolicy(context)

    expect(result.status).not.toBe(0)
    expect(result.stderr.match(/destructive-operation/g)?.length).toBeGreaterThanOrEqual(3)
  })

  it('requires the canonical rejected-operation protection set', () => {
    const plan = readCanonicalPlan()
    plan.rejectedOperations = []
    const context = createContext(plan)

    const result = runPolicy(context)

    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('rejected-operation-gap')
    expect(result.stderr).toContain('remove-cloned-private-voice-profiles')
  })

  it('rejects explicit route policy downgrades', () => {
    const plan = readCanonicalPlan()
    plan.routePolicy = {
      ...plan.routePolicy,
      webrtcPreferredHttpOnlyWhenGatewayAvailable: false,
      pureWebRemoteSpeechOnlyWhenAuthorized: false,
      webrtcOnlyFailClosed: false,
      desktopLocalRemainsSeparate: false,
      retainNativePttWhenOnlyMobileBackgroundWithdrawn: false,
      externalOnlyCapabilities: true,
    }
    const context = createContext(plan)

    const result = runPolicy(context)

    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('route-policy-unsafe')
    expect(result.stderr).toContain('external-only-unsafe')
  })

  it('redacts plan-controlled secrets from stdout, stderr, and report failures', () => {
    const plan = readCanonicalPlan()
    plan.policyId = 'RAC-54-OPENAI_API_KEY=sk-123456789012345678901234'
    plan.scope = {
      ...plan.scope,
      kind: 'policy-gate-only-password=super-secret-value',
      reportClaim: 'static policy only Bearer abcdefghijklmnopqrstuvwxyz https://user:pass@example.invalid/path',
    }
    plan.statePreservation = {
      ...plan.statePreservation,
      preserve: [
        ...plan.statePreservation.preserve.filter((item) => item !== 'room-secret-references'),
        'room-secret=room-secret-value',
        'peer-credential=peer-credential-value',
      ],
    }
    const context = createContext(plan)

    const result = runPolicy(context)

    const combinedOutput = `${result.stdout}\n${result.stderr}`
    const reportText = readFileSync(context.reportPath, 'utf8')
    for (const leaked of [
      'sk-123456789012345678901234',
      'super-secret-value',
      'abcdefghijklmnopqrstuvwxyz',
      'user:pass@example.invalid',
      'room-secret-value',
      'peer-credential-value',
      context.root,
    ]) {
      expect(combinedOutput).not.toContain(leaked)
      expect(reportText).not.toContain(leaked)
    }
    const report = JSON.parse(reportText) as { failures: string[], status: string, secretsRedacted: boolean }
    expect(result.status).not.toBe(0)
    expect(report.status).toBe('failed')
    expect(report.failures.length).toBeGreaterThan(0)
    expect(report.secretsRedacted).toBe(true)
  })

  it('is exposed as a package script for release readiness', () => {
    const packageJson = JSON.parse(
      readFileSync(join(packageRoot, 'package.json'), 'utf8'),
    ) as { scripts: Record<string, string> }

    expect(packageJson.scripts['verify:static-release-rollback-policy']).toBe(
      'node ./scripts/assert-release-rollback-plan.mjs',
    )
    const root = mkdtempSync(join(tmpdir(), 'aurora-release-rollback-plan-script-'))
    const result = runPackageScript(join(root, 'release-rollback-plan-policy.json'))
    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout).toContain('Runtime rollback is not proven by this check')
  })

  it('is enforced by release.yml and uploads the report even on failure', () => {
    const workflow = readFileSync(releaseWorkflow, 'utf8')

    expect(workflow).toContain('pnpm --filter @aurora/tauri-ui verify:static-release-rollback-policy')
    expect(workflow).toContain('apps/aurora-tauri/reports/release-rollback-plan-policy.json')
    expect(workflow).toContain('if: always()')
    expect(workflow).toContain('actions/upload-artifact@v4')
  })

  it('does not accept workflow wiring hidden in comments or after semantic versioning', () => {
    const context = createContext()
    const workflowPath = join(context.root, 'release.yml')
    writeFileSync(workflowPath, `
name: Release
jobs:
  release-readiness:
    steps:
      - name: Run lightweight release check
        run: |
          pnpm --filter @aurora/client build
          # pnpm --filter @aurora/tauri-ui verify:static-release-rollback-policy
      - name: Check next semantic version
        run: echo version
      - name: Upload static release rollback policy report
        if: always()
        uses: actions/upload-artifact@v4
        with:
          path: apps/aurora-tauri/reports/release-rollback-plan-policy.json
      - name: Late static policy
        run: pnpm --filter @aurora/tauri-ui verify:static-release-rollback-policy
`)

    const result = runPolicyWithWorkflow(context, workflowPath)

    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('workflow-wiring')
    expect(result.stderr).toContain('workflow-ordering')
  })
})
