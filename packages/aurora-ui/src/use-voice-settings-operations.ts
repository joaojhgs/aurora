import { useEffect, useRef, useState } from 'react'
import {
  routePath,
  type AuroraClient,
  type GeneratedBackendMethodInput,
  type GeneratedBackendMethodOutput,
  type JsonObject,
  type JsonValue,
} from '@aurora/client'
import { type ManagedVoiceConfirmation } from './voice-settings-managed-voices-section'
import { confirmedTtsSelection, type ManagedVoice } from './voice-settings-managed-voice-model'
import { adminReasonFor, productVoiceSettingsErrorCopy, TTS_MANAGE_METHODS } from './use-speech-catalog'
import type { AuroraLocalSpeechSelectionProfile } from './runtime-profile'

type InstallStatus = 'installed' | 'not_found' | 'queued' | 'rejected' | 'revision_conflict' | 'unchanged'
type RemoveStatus = 'drained' | 'not_found' | 'rejected' | 'removed' | 'revision_conflict' | 'unchanged'
type DefaultStatus = 'activated' | 'drained' | 'not_found' | 'rejected' | 'revision_conflict'
type DeleteStatus = 'deleted' | 'not_found' | 'rejected' | 'revision_conflict'
type ExportStatus = GeneratedBackendMethodOutput<'TTS.ExportVoiceProfile'>['status']
type ImportStatus = GeneratedBackendMethodOutput<'TTS.ImportVoiceProfile'>['status']
type VoiceMutationKind = 'default' | 'delete' | 'export' | 'import' | 'install' | 'remove'
type VoiceConfirmation = ManagedVoiceConfirmation<ManagedVoice>
type VoiceScopeToken = { scopeKey: string; generation: number; mounted: boolean }

const CLONE_VOICE_IMPORT_FILE_MAX_BYTES = 3 * 1024 * 1024

interface CloneTransferBundle extends JsonObject {
  bundle_type: 'aurora-cloned-tts-voice-state'
  voice_id: string
  display_name: string
  artifact_revision?: string | null | undefined
  artifact_data_base64: string
  artifact_sha256: string
  artifact_size_bytes: number
  [key: string]: JsonValue | undefined
}

interface VoiceManagePayload extends JsonObject {
  voice_id: string
  expected_revision: string
  operation_id: string
}

type VoiceManageMutationMethodId =
  | typeof TTS_MANAGE_METHODS.install
  | typeof TTS_MANAGE_METHODS.remove
  | typeof TTS_MANAGE_METHODS.setDefault
  | typeof TTS_MANAGE_METHODS.delete

interface MutationOutput<TStatus extends string> {
  status: TStatus
  voice_id: string
  revision: string | null
  idempotent: boolean
  correlation_id?: string | null
}

export interface UseVoiceSettingsOperationsInput {
  client: AuroraClient
  managementLoading: boolean
  adminReasonValue: string
  adminReviewConfirmed: boolean
  adminActionReady: boolean
  scopeKey: string
  capabilities: Parameters<typeof confirmedTtsSelection>[1]
  packs: Parameters<typeof confirmedTtsSelection>[2]
  currentVoiceScopeToken: () => VoiceScopeToken
  isCurrentVoiceScope: (token: VoiceScopeToken) => boolean
  invalidateVoiceServerData: (reason?: string) => Promise<void>
  persistConfirmedLocalSpeechSelection: (
    selection: AuroraLocalSpeechSelectionProfile | null,
    scopeToken: VoiceScopeToken,
  ) => Promise<boolean>
}

export function useVoiceSettingsOperations(input: UseVoiceSettingsOperationsInput) {
  const [installingVoiceId, setInstallingVoiceId] = useState<string | null>(null)
  const [installMessage, setInstallMessage] = useState<string | null>(null)
  const [pendingActionKey, setPendingActionKey] = useState<string | null>(null)
  const [mutationMessage, setMutationMessage] = useState<string | null>(null)
  const [transferMessage, setTransferMessage] = useState<string | null>(null)
  const [importFile, setImportFile] = useState<File | null>(null)
  const [confirmAction, setConfirmAction] = useState<VoiceConfirmation | null>(null)
  const importFileInputRef = useRef<HTMLInputElement | null>(null)
  const actionPending = pendingActionKey !== null || input.managementLoading

  useEffect(() => {
    setConfirmAction(null)
    setInstallingVoiceId(null)
    setPendingActionKey(null)
    setInstallMessage(null)
    setMutationMessage(null)
    setTransferMessage(null)
  }, [input.scopeKey])

  async function installProfile(profile: ManagedVoice): Promise<void> {
    if (!profile.installable || actionPending || !input.adminActionReady) return
    const scopeToken = input.currentVoiceScopeToken()
    setInstallingVoiceId(profile.voiceId)
    setPendingActionKey(actionKeyFor('install', profile.voiceId))
    setInstallMessage(null)
    try {
      const result = await runVoiceAdminMutation<InstallStatus>(input.client, {
        methodId: TTS_MANAGE_METHODS.install,
        payload: { voice_id: profile.voiceId, expected_revision: profile.revision, operation_id: createInstallOperationId() },
        reason: adminReasonFor('Add spoken reply voice', input.adminReasonValue),
        reauthConfirmed: input.adminReviewConfirmed,
        affectedResources: affectedVoiceResources(profile),
        path: routePath('TTS', 'InstallVoiceProfile'),
      })
      if (!input.isCurrentVoiceScope(scopeToken)) return
      setInstallMessage(installOutcomeCopy(result.status))
      if (isInstallSuccess(result.status)) {
        if (!await persistConfirmedTtsSelection(profile, scopeToken)) {
          if (input.isCurrentVoiceScope(scopeToken)) setInstallMessage('Voice added. Choose it again if it is missing next time.')
        }
        if (!input.isCurrentVoiceScope(scopeToken)) return
        await input.invalidateVoiceServerData('Refresh available voice settings')
      }
    } catch (error) {
      if (input.isCurrentVoiceScope(scopeToken)) setInstallMessage(productVoiceSettingsErrorCopy(error, 'Voice was not added. Try again.'))
    } finally {
      if (input.isCurrentVoiceScope(scopeToken)) {
        setInstallingVoiceId(null)
        setPendingActionKey(null)
      }
    }
  }

  async function setDefaultProfile(profile: ManagedVoice): Promise<void> {
    if (!profile.canSetDefault || actionPending || !input.adminActionReady) return
    const scopeToken = input.currentVoiceScopeToken()
    setPendingActionKey(actionKeyFor('default', profile.voiceId))
    setMutationMessage('Updating voice choice.')
    try {
      const result = await runVoiceAdminMutation<DefaultStatus>(input.client, {
        methodId: TTS_MANAGE_METHODS.setDefault,
        payload: { voice_id: profile.voiceId, expected_revision: profile.revision, operation_id: createVoiceOperationId('default') },
        reason: adminReasonFor('Update spoken reply voice choice', input.adminReasonValue),
        reauthConfirmed: input.adminReviewConfirmed,
        affectedResources: affectedVoiceResources(profile),
        path: routePath('TTS', 'SetDefaultVoice'),
      })
      if (!input.isCurrentVoiceScope(scopeToken)) return
      setMutationMessage(defaultOutcomeCopy(result.status))
      if (isDefaultSuccess(result.status)) {
        if (!await persistConfirmedTtsSelection(profile, scopeToken)) {
          if (input.isCurrentVoiceScope(scopeToken)) setMutationMessage('Voice choice updated. Choose it again if it is missing next time.')
        }
        if (!input.isCurrentVoiceScope(scopeToken)) return
        await input.invalidateVoiceServerData('Refresh available voice settings')
      }
    } catch (error) {
      if (input.isCurrentVoiceScope(scopeToken)) setMutationMessage(productVoiceSettingsErrorCopy(error, 'Voice choice was not changed. Try again.'))
    } finally {
      if (input.isCurrentVoiceScope(scopeToken)) setPendingActionKey(null)
    }
  }

  async function runConfirmedAction(action: VoiceConfirmation): Promise<void> {
    if (actionPending || !input.adminActionReady) return
    const scopeToken = input.currentVoiceScopeToken()
    setPendingActionKey(actionKeyFor(action.kind, action.profile.voiceId))
    setMutationMessage(action.kind === 'remove' ? 'Removing voice.' : 'Deleting voice.')
    try {
      const result = await runVoiceAdminMutation<RemoveStatus | DeleteStatus>(input.client, {
        methodId: action.kind === 'remove' ? TTS_MANAGE_METHODS.remove : TTS_MANAGE_METHODS.delete,
        payload: { voice_id: action.profile.voiceId, expected_revision: action.profile.revision, operation_id: createVoiceOperationId(action.kind) },
        reason: adminReasonFor(action.kind === 'remove' ? 'Remove spoken reply voice' : 'Delete spoken reply voice', input.adminReasonValue),
        reauthConfirmed: input.adminReviewConfirmed,
        affectedResources: affectedVoiceResources(action.profile),
        path: routePath('TTS', action.kind === 'remove' ? 'RemoveVoiceProfile' : 'DeleteVoiceProfile'),
      })
      if (!input.isCurrentVoiceScope(scopeToken)) return
      if (action.kind === 'remove') {
        const status = result.status as RemoveStatus
        setMutationMessage(removeOutcomeCopy(status))
        if (isRemoveSuccess(status)) await input.invalidateVoiceServerData('Refresh available voice settings')
      } else {
        const status = result.status as DeleteStatus
        setMutationMessage(deleteOutcomeCopy(status))
        if (isDeleteSuccess(status)) await input.invalidateVoiceServerData('Refresh available voice settings')
      }
      setConfirmAction(null)
    } catch (error) {
      if (input.isCurrentVoiceScope(scopeToken)) setMutationMessage(productVoiceSettingsErrorCopy(error, action.kind === 'remove' ? 'Voice was not removed. Try again.' : 'Voice was not deleted. Try again.'))
    } finally {
      if (input.isCurrentVoiceScope(scopeToken)) setPendingActionKey(null)
    }
  }

  async function exportCloneVoice(profile: ManagedVoice): Promise<void> {
    if (!profile.canExport || actionPending || !input.adminActionReady) return
    const scopeToken = input.currentVoiceScopeToken()
    setPendingActionKey(actionKeyFor('export', profile.voiceId))
    setTransferMessage('Preparing voice file.')
    try {
      const result = await input.client.speech.tts.exportVoiceProfile({ voice_id: profile.voiceId, expected_revision: profile.revision, operation_id: createVoiceOperationId('export') })
      if (!input.isCurrentVoiceScope(scopeToken)) return
      if (!result.ok) { setTransferMessage(productVoiceSettingsErrorCopy(result.error, exportOutcomeCopy('rejected'))); return }
      setTransferMessage(exportOutcomeCopy(result.data.status))
      if (result.data.status === 'exported' && isCloneTransferBundle(result.data.bundle)) {
        downloadCloneVoiceBundle(result.data.bundle)
        setTransferMessage('Voice file downloaded.')
      }
    } catch (error) {
      if (input.isCurrentVoiceScope(scopeToken)) setTransferMessage(productVoiceSettingsErrorCopy(error, exportOutcomeCopy('rejected')))
    } finally {
      if (input.isCurrentVoiceScope(scopeToken)) setPendingActionKey(null)
    }
  }

  async function importCloneVoice(): Promise<void> {
    if (actionPending || !input.adminActionReady) return
    const scopeToken = input.currentVoiceScopeToken()
    const file = importFile ?? importFileInputRef.current?.files?.[0] ?? null
    if (!file) { setTransferMessage('Choose a voice file first.'); return }
    setPendingActionKey(actionKeyFor('import', file.name || 'selected'))
    setTransferMessage('Adding voice file.')
    try {
      const bundle = await readCloneVoiceBundleFile(file)
      const result = await input.client.speech.tts.importVoiceProfile({ bundle, operation_id: createVoiceOperationId('import') })
      if (!input.isCurrentVoiceScope(scopeToken)) return
      if (!result.ok) { setTransferMessage(productVoiceSettingsErrorCopy(result.error, importOutcomeCopy('rejected'))); return }
      setTransferMessage(importOutcomeCopy(result.data.status))
      if (isImportSuccess(result.data.status)) {
        setImportFile(null)
        if (importFileInputRef.current) importFileInputRef.current.value = ''
        await input.invalidateVoiceServerData('Refresh available voice settings')
      }
    } catch (error) {
      if (input.isCurrentVoiceScope(scopeToken)) setTransferMessage(productCloneTransferErrorCopy(error, importOutcomeCopy('rejected')))
    } finally {
      if (input.isCurrentVoiceScope(scopeToken)) setPendingActionKey(null)
    }
  }

  async function persistConfirmedTtsSelection(profile: ManagedVoice, scopeToken: VoiceScopeToken): Promise<boolean> {
    return input.persistConfirmedLocalSpeechSelection(confirmedTtsSelection(profile, input.capabilities, input.packs), scopeToken)
  }

  return {
    actionPending,
    confirmAction,
    importFile,
    importFileInputRef,
    installMessage,
    installingVoiceId,
    mutationMessage,
    pendingActionKey,
    setConfirmAction,
    setImportFile,
    setMutationMessage,
    setPendingActionKey,
    setTransferMessage,
    transferMessage,
    exportCloneVoice,
    importCloneVoice,
    installProfile,
    runConfirmedAction,
    setDefaultProfile,
  }
}

async function runVoiceAdminMutation<TStatus extends string>(client: AuroraClient, input: { methodId: VoiceManageMutationMethodId; payload: VoiceManagePayload; reason: string; reauthConfirmed: boolean; affectedResources: string[]; path: string }): Promise<MutationOutput<TStatus>> {
  const result = await client.admin.execute<MutationOutput<TStatus>>({ ...input })
  return result.data
}

function affectedVoiceResources(profile: Pick<ManagedVoice, 'voiceId'>): string[] { return [`voice-profile:${profile.voiceId}`] }
export function actionKeyFor(kind: VoiceMutationKind, voiceId: string): string { return `${kind}:${voiceId}` }
let fallbackInstallOperationSequence = 0
let fallbackVoiceOperationSequence = 0
function createInstallOperationId(): string { return createVoiceOperationId('install') }
function createVoiceOperationId(kind: VoiceMutationKind): string {
  const randomId = globalThis.crypto?.randomUUID?.()
  if (randomId) return `voice-${kind}-${randomId}`
  if (kind === 'install') {
    fallbackInstallOperationSequence = (fallbackInstallOperationSequence + 1) % Number.MAX_SAFE_INTEGER
    return `voice-install-${Date.now().toString(36)}-${fallbackInstallOperationSequence.toString(36)}`
  }
  fallbackVoiceOperationSequence = (fallbackVoiceOperationSequence + 1) % Number.MAX_SAFE_INTEGER
  return `voice-${kind}-${Date.now().toString(36)}-${fallbackVoiceOperationSequence.toString(36)}`
}
function installOutcomeCopy(status: InstallStatus): string {
  if (status === 'installed') return 'Voice added.'
  if (status === 'queued') return 'Voice will be added soon.'
  if (status === 'unchanged') return 'Voice is already available.'
  if (status === 'revision_conflict') return 'Voice changed before it could be added. Try again.'
  if (status === 'not_found') return 'Voice is no longer available.'
  return 'Voice was not added. Try again.'
}

function defaultOutcomeCopy(status: DefaultStatus): string {
  if (status === 'activated') return 'Voice choice updated.'
  if (status === 'drained') return 'Voice choice will update after current speech finishes.'
  if (status === 'revision_conflict') return 'Voice changed before it could be selected. Try again.'
  if (status === 'not_found') return 'Voice is no longer available.'
  return 'Voice choice was not changed. Try again.'
}

function removeOutcomeCopy(status: RemoveStatus): string {
  if (status === 'removed') return 'Voice removed.'
  if (status === 'drained') return 'Voice will be removed after current speech finishes.'
  if (status === 'unchanged') return 'Voice was already removed.'
  if (status === 'revision_conflict') return 'Voice changed before it could be removed. Try again.'
  if (status === 'not_found') return 'Voice is no longer available.'
  return 'Voice was not removed. Try again.'
}

function deleteOutcomeCopy(status: DeleteStatus): string {
  if (status === 'deleted') return 'Voice deleted.'
  if (status === 'revision_conflict') return 'Voice changed before it could be deleted. Try again.'
  if (status === 'not_found') return 'Voice is no longer available.'
  return 'Voice was not deleted. Try again.'
}

function exportOutcomeCopy(status: ExportStatus): string {
  if (status === 'exported') return 'Voice file downloaded.'
  if (status === 'revision_conflict') return 'Voice changed before it could be downloaded. Try again.'
  if (status === 'not_found') return 'Voice is no longer available.'
  if (status === 'unavailable') return 'Voice file is unavailable on this Aurora.'
  return 'Voice file was not downloaded. Try again.'
}

function importOutcomeCopy(status: ImportStatus): string {
  if (status === 'imported') return 'Voice file added.'
  if (status === 'unchanged') return 'Voice is already available.'
  if (status === 'conflict') return 'Voice changed before it could be added. Try again.'
  if (status === 'unavailable') return 'Voice file cannot be added on this Aurora.'
  return 'Voice file was not added. Try again.'
}
function isInstallSuccess(status: InstallStatus): boolean { return status === 'installed' || status === 'queued' || status === 'unchanged' }
function isDefaultSuccess(status: DefaultStatus): boolean { return status === 'activated' || status === 'drained' }
function isRemoveSuccess(status: RemoveStatus): boolean { return status === 'removed' || status === 'drained' || status === 'unchanged' || status === 'not_found' }
function isDeleteSuccess(status: DeleteStatus): boolean { return status === 'deleted' || status === 'not_found' }
function isImportSuccess(status: ImportStatus): boolean { return status === 'imported' || status === 'unchanged' }
function productCloneTransferErrorCopy(error: unknown, backup: string): string {
  if (error instanceof Error && error.message === 'voice_file_invalid') {
    return 'Choose a valid Aurora voice file.'
  }
  return productVoiceSettingsErrorCopy(error, backup)
}

function isCloneTransferBundle(value: unknown): value is NonNullable<CloneTransferBundle> {
  if (!value || typeof value !== 'object') return false
  const record = value as Record<string, unknown>
  return record.bundle_type === 'aurora-cloned-tts-voice-state' && typeof record.voice_id === 'string' && record.voice_id.startsWith('clone:') && typeof record.display_name === 'string' && typeof record.artifact_data_base64 === 'string' && typeof record.artifact_sha256 === 'string' && typeof record.artifact_size_bytes === 'number'
}
function downloadCloneVoiceBundle(bundle: NonNullable<CloneTransferBundle>): void {
  if (typeof document === 'undefined' || !bundle) return
  const payload = JSON.stringify(bundle)
  const blob = new Blob([payload], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = cloneVoiceBundleFilename(bundle)
  try {
    link.click()
  } finally {
    URL.revokeObjectURL(url)
  }
}
function cloneVoiceBundleFilename(bundle: NonNullable<CloneTransferBundle>): string {
  const name = safeFilenamePart(bundle.display_name)
  const revision = safeFilenamePart(bundle.artifact_revision)
  return ['aurora-voice', name, revision].filter(Boolean).join('-').concat('.json')
}

function safeFilenamePart(value: string | null | undefined): string {
  return (value ?? '')
    .trim()
    .replace(/[^A-Za-z0-9_-]+/gu, '-')
    .replace(/-+/gu, '-')
    .replace(/^-|-$/gu, '')
    .slice(0, 80)
}
async function readCloneVoiceBundleFile(file: File): Promise<GeneratedBackendMethodInput<'TTS.ImportVoiceProfile'>['bundle']> {
  if (file.size <= 0 || file.size > CLONE_VOICE_IMPORT_FILE_MAX_BYTES) throw new Error('voice_file_invalid')
  const text = new TextDecoder().decode(await file.arrayBuffer())
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new Error('voice_file_invalid')
  }
  if (!isCloneTransferBundle(parsed)) throw new Error('voice_file_invalid')
  return parsed
}
