import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

type ActionGuardRow = {
  id: string
  route: string
  handler: string
  sourceFile: string
  relatedSourceFiles?: readonly string[]
  sourceReference: string
  controlGuard: string
  userResult: string
  evidence: string
  runtimeStatus: 'pending'
}

const uiSource = join(dirname(fileURLToPath(import.meta.url)), '../src')
const reviewEvidence = '.omx/evidence/ui-original-task-closure-map-20260917.md:149-165'

const ACTION_GUARD_CENSUS: readonly ActionGuardRow[] = [
  {
    id: 'assistant-send',
    route: 'Assistant',
    handler: 'onSubmit / onPrimaryComposerAction',
    sourceFile: 'assistant-composer.tsx',
    sourceReference: 'primary composer control',
    controlGuard: 'primaryComposerDisabled',
    userResult: 'Sends, stops, or retries the current assistant turn.',
    evidence: 'packages/aurora-ui/tests/assistant-unified-execution.test.tsx',
    runtimeStatus: 'pending',
  },
  {
    id: 'assistant-retry',
    route: 'Assistant',
    handler: 'onRetryLastPrompt',
    sourceFile: 'assistant-view-shell.tsx',
    sourceReference: 'retry button',
    controlGuard: '!lastPrompt || !canSend',
    userResult: 'Retries the last prompt when a retryable prompt is present.',
    evidence: reviewEvidence,
    runtimeStatus: 'pending',
  },
  {
    id: 'assistant-remote-audio-consent',
    route: 'Assistant',
    handler: 'onToggleRemoteAudioConsent',
    sourceFile: 'assistant-composer.tsx',
    sourceReference: 'remote audio consent button',
    controlGuard: 'remoteAudioConsentPending',
    userResult: 'Grants or revokes remote audio consent.',
    evidence: 'packages/aurora-ui/src/use-assistant-voice.test.ts',
    runtimeStatus: 'pending',
  },
  {
    id: 'assistant-voice-capture',
    route: 'Assistant',
    handler: 'onRequestVoiceToggle',
    sourceFile: 'assistant-composer.tsx',
    sourceReference: 'voice capture button',
    controlGuard: 'voiceCaptureStatus === \'processing\'',
    userResult: 'Starts or stops focused voice capture.',
    evidence: 'packages/aurora-ui/tests/assistant-browser-voice-runtime.test.tsx',
    runtimeStatus: 'pending',
  },
  {
    id: 'mesh-discovered-connect',
    route: 'Mesh peers',
    handler: 'onConnect',
    sourceFile: 'mesh-peers-roster.tsx',
    sourceReference: 'discovered device setup button',
    controlGuard: 'pendingPeerIds.has(device.peerId)',
    userResult: 'Starts one connection attempt for the selected device.',
    evidence: 'packages/aurora-ui/tests/mesh-device-discovery.test.tsx',
    runtimeStatus: 'pending',
  },
  {
    id: 'mesh-peer-review',
    route: 'Mesh peers',
    handler: 'onReview / onForget',
    sourceFile: 'mesh-peers-roster.tsx',
    sourceReference: 'pairing review and forget buttons',
    controlGuard: 'pending / forgetPending',
    userResult: 'Opens the selected peer or removes it after confirmation.',
    evidence: 'packages/aurora-ui/tests/mesh-peers-decomposition.test.tsx',
    runtimeStatus: 'pending',
  },
  {
    id: 'mesh-peer-mutations',
    route: 'Mesh peers',
    handler: 'saveScopes / saveLocalScopes / connectDiscoveredDevice',
    sourceFile: 'mesh-peers-view.tsx',
    sourceReference: 'mesh settings and mutation controls',
    controlGuard: 'homeServerMutationsDisabled / controlsDisabled',
    userResult: 'Saves peer permissions or starts a peer connection.',
    evidence: reviewEvidence,
    runtimeStatus: 'pending',
  },
  {
    id: 'pairing-actions',
    route: 'Pairing queue',
    handler: 'submitPairingAction / createPairingCredential / exchangePairingCode / revokeExchangedToken',
    sourceFile: 'pairing-queue-view.tsx',
    sourceReference: 'approve, deny, create, exchange, and revoke controls',
    controlGuard: 'actionDisabled / pendingAction / canCreate / canExchange / canRevokeToken',
    userResult: 'Submits the selected pairing or credential action and reports its result.',
    evidence: 'packages/aurora-ui/tests/admin-pairing-view.test.tsx',
    runtimeStatus: 'pending',
  },
  {
    id: 'backup-actions',
    route: 'Backups',
    handler: 'confirmPending',
    sourceFile: 'backup-restore-view.tsx',
    sourceReference: 'create, verify, and restore confirmation controls',
    controlGuard: 'actionDisabled derived from busy / pending',
    userResult: 'Creates, verifies, or previews restoration of a backup.',
    evidence: 'packages/aurora-ui/tests/admin-backups-view.test.tsx',
    runtimeStatus: 'pending',
  },
  {
    id: 'config-actions',
    route: 'Configuration',
    handler: 'applyChanges / clearEdits / openRollbackDialog',
    sourceFile: 'config-editor-view.tsx',
    sourceReference: 'apply, rollback, and edit controls',
    controlGuard: 'effectiveBusy / reviewBlocked',
    userResult: 'Applies, rolls back, or clears configuration changes.',
    evidence: 'packages/aurora-ui/tests/admin-config-view.test.tsx',
    runtimeStatus: 'pending',
  },
  {
    id: 'managed-voice-actions',
    route: 'Voice settings',
    handler: 'onSetDefaultProfile / onInstallProfile / onRequestConfirmation / onImportCloneVoice',
    sourceFile: 'voice-settings-managed-voices-section.tsx',
    sourceReference: 'managed voice action controls',
    controlGuard: 'actionPending / pendingActionKey',
    userResult: 'Installs, selects, removes, deletes, exports, or imports a managed voice.',
    evidence: 'packages/aurora-ui/tests/voice-settings-view.test.tsx',
    runtimeStatus: 'pending',
  },
  {
    id: 'onboarding-actions',
    route: 'Onboarding',
    handler: 'onManualAddress / onLogin / onValidateToken / onStartPairing / onExchangePairing / onFinishSetup',
    sourceFile: 'onboarding-view.tsx',
    sourceReference: 'onboarding forms and action buttons',
    controlGuard: 'busy !== null',
    userResult: 'Connects, authenticates, pairs, or completes setup.',
    evidence: 'packages/aurora-ui/tests/onboarding-and-mesh-baseline.test.tsx',
    runtimeStatus: 'pending',
  },
  {
    id: 'web-thin-actions',
    route: 'Web thin connection',
    handler: 'saveProfile / connectInvite / confirmPairing / reconnect',
    sourceFile: 'web-thin-connection-panel.tsx',
    sourceReference: 'profile, invite, pairing, and connection controls',
    controlGuard: 'profilePending / invitePending / pairingApprovalPending / connectDisabled',
    userResult: 'Saves a connection profile or connects and reconnects to a peer.',
    evidence: 'packages/aurora-ui/tests/web-thin-runtime.test.tsx',
    runtimeStatus: 'pending',
  },
  {
    id: 'memory-actions',
    route: 'Memory',
    handler: 'onSubmit / delete action from model.actions.delete',
    sourceFile: 'memory-view.tsx',
    sourceReference: 'search form and delete control',
    controlGuard: 'model.actions.delete.disabled plus search/loading state',
    userResult: 'Searches memory or deletes the selected conversation.',
    evidence: 'packages/aurora-ui/tests/memory-data-policy-view.test.tsx',
    runtimeStatus: 'pending',
  },
  {
    id: 'scheduler-actions',
    route: 'Admin scheduler',
    handler: 'submitCreate / onRun',
    sourceFile: 'admin-scheduler-view.tsx',
    sourceReference: 'create and run controls',
    controlGuard: 'pending / createControl.available',
    userResult: 'Creates a schedule or runs the selected job.',
    evidence: 'packages/aurora-ui/tests/admin-scheduler-view.test.tsx',
    runtimeStatus: 'pending',
  },
  {
    id: 'admin-token-plugin-actions',
    route: 'Admin tokens and plugins',
    handler: 'createToken / submit / onUpdateScopes / toggleSourceActive / createMcpSource / createPluginSource',
    sourceFile: 'admin-tokens-view.tsx',
    relatedSourceFiles: ['admin-plugins-view.tsx'],
    sourceReference: 'token controls and plugin source controls',
    controlGuard: 'busyAction !== null / pendingAction / !canSubmit',
    userResult: 'Creates, updates, revokes, or configures an administrator resource.',
    evidence: 'packages/aurora-ui/tests/admin-tokens-view.test.tsx; packages/aurora-ui/tests/admin-plugins-view.test.tsx',
    runtimeStatus: 'pending',
  },
  {
    id: 'native-permission-request',
    route: 'Settings permissions',
    handler: 'requestAccess',
    sourceFile: 'settings-permissions-view.tsx',
    sourceReference: 'native permission request button',
    controlGuard: 'requestingPermissionId === null',
    userResult: 'Requests the selected native permission and reports its state.',
    evidence: reviewEvidence,
    runtimeStatus: 'pending',
  },
]

describe('PER-282 async action guard census', () => {
  it('keeps the reviewed route/action table complete without claiming runtime acceptance', () => {
    expect(ACTION_GUARD_CENSUS).toHaveLength(17)
    expect(new Set(ACTION_GUARD_CENSUS.map((entry) => entry.id)).size).toBe(17)

    for (const entry of ACTION_GUARD_CENSUS) {
      expect(entry.route).toBeTruthy()
      expect(entry.handler).toBeTruthy()
      expect(entry.controlGuard).toBeTruthy()
      expect(entry.userResult).toBeTruthy()
      expect(entry.evidence).toBeTruthy()
      expect(entry.runtimeStatus).toBe('pending')
      for (const sourceFile of [entry.sourceFile, ...(entry.relatedSourceFiles ?? [])]) {
        expect(existsSync(join(uiSource, sourceFile)), sourceFile).toBe(true)
        expect(readFileSync(join(uiSource, sourceFile), 'utf8')).toBeTruthy()
      }
    }
  })
})
