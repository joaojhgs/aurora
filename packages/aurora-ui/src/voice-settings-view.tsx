'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { routePath, type AuroraClient, type JsonObject } from '@aurora/client'
import { Button, Card, StatStrip } from './primitives'
import { safeErrorCopy } from './product-copy'
import { findForbiddenProductionCopyTerms } from './product-copy-forbidden-terms'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle
} from '#components/ui/alert-dialog'
import { Badge } from '#components/ui/badge'

type SpeechLanguage = 'de' | 'en' | 'es' | 'fr' | 'it' | 'ja' | 'ko' | 'pt' | 'zh'
type TtsModelStatus = 'degraded' | 'error' | 'loading' | 'ready' | 'unavailable'
type TtsVoiceKind = 'cloned' | 'standard'
type InstallStatus = 'installed' | 'not_found' | 'queued' | 'rejected' | 'revision_conflict' | 'unchanged'
type RemoveStatus = 'drained' | 'not_found' | 'rejected' | 'removed' | 'revision_conflict' | 'unchanged'
type DefaultStatus = 'activated' | 'drained' | 'not_found' | 'rejected' | 'revision_conflict'
type DeleteStatus = 'deleted' | 'not_found' | 'rejected' | 'revision_conflict'
type VoiceMutationKind = 'default' | 'delete' | 'install' | 'remove'

interface TtsResidentLanguagePack {
  pack_id: string
  ready_languages?: SpeechLanguage[] | undefined
}

interface TtsCapabilities {
  ready?: boolean | undefined
  model_status?: TtsModelStatus | undefined
  ready_languages?: SpeechLanguage[] | undefined
  supported_language_pack_ids?: string[] | undefined
  installed_language_pack_ids?: string[] | undefined
  resident_language_packs?: TtsResidentLanguagePack[] | undefined
}

interface TtsVoice {
  voice_id: string
  display_name: string
  ready?: boolean | undefined
  compatible_language_pack_ids?: string[] | undefined
}

interface TtsVoiceProfile {
  voice_id: string
  display_name: string
  revision: string
  kind: TtsVoiceKind
  active?: boolean | undefined
  default?: boolean | undefined
  enabled?: boolean | undefined
  installed?: boolean | undefined
  ready?: boolean | undefined
  retained_source?: boolean | undefined
  compatible_language_pack_ids?: string[] | undefined
}

interface VoiceSettingsState {
  capabilities: TtsCapabilities | null
  voices: TtsVoice[]
  profiles: TtsVoiceProfile[]
  loadState: 'loading' | 'ready' | 'error'
  managementState: 'locked' | 'loading' | 'ready' | 'limited'
  message: string | null
}

const initialVoiceSettingsState: VoiceSettingsState = {
  capabilities: null,
  voices: [],
  profiles: [],
  loadState: 'loading',
  managementState: 'locked',
  message: null
}

let fallbackInstallOperationSequence = 0
let fallbackVoiceOperationSequence = 0

const TTS_MANAGE_METHODS = {
  install: 'TTS.InstallVoiceProfile',
  listProfiles: 'TTS.ListVoiceProfiles',
  remove: 'TTS.RemoveVoiceProfile',
  setDefault: 'TTS.SetDefaultVoice',
  delete: 'TTS.DeleteVoiceProfile'
} as const

export interface VoiceSettingsViewProps {
  client: AuroraClient
}

export function VoiceSettingsView({ client }: VoiceSettingsViewProps) {
  const [state, setState] = useState<VoiceSettingsState>(initialVoiceSettingsState)
  const [installingVoiceId, setInstallingVoiceId] = useState<string | null>(null)
  const [installMessage, setInstallMessage] = useState<string | null>(null)
  const [pendingActionKey, setPendingActionKey] = useState<string | null>(null)
  const [mutationMessage, setMutationMessage] = useState<string | null>(null)
  const [confirmAction, setConfirmAction] = useState<VoiceConfirmation | null>(null)
  const [adminReason, setAdminReason] = useState('Manage spoken reply voices')
  const [adminReviewConfirmed, setAdminReviewConfirmed] = useState(false)
  const adminReasonValue = adminReason.trim()
  const adminActionReady = adminReviewConfirmed && adminReasonValue.length > 0

  const refresh = useCallback(() => {
    let active = true
    setState((current) => ({
      ...current,
      capabilities: null,
      voices: [],
      loadState: 'loading',
      message: current.managementState === 'limited' ? current.message : null
    }))

    void Promise.all([
      client.speech.tts.getCapabilities(),
      client.speech.tts.listVoices()
    ]).then(([capabilitiesResult, voicesResult]) => {
      if (!active) return
      const capabilities = capabilitiesResult.ok ? capabilitiesResult.data.capabilities as TtsCapabilities : null
      const voices = voicesResult.ok ? (voicesResult.data.voices as TtsVoice[] | undefined) ?? [] : []
      const readError = !capabilitiesResult.ok || !voicesResult.ok
      const readProblem = capabilitiesResult.ok
        ? voicesResult.ok ? null : voicesResult.error
        : capabilitiesResult.error
      setState((current) => ({
        ...current,
        capabilities,
        voices,
        loadState: readError ? 'error' : 'ready',
        message: readError
          ? productVoiceSettingsErrorCopy(readProblem)
          : current.managementState === 'limited'
            ? current.message
            : null
      }))
    }, (error: unknown) => {
      if (!active) return
      setState((current) => ({
        ...current,
        capabilities: null,
        voices: [],
        loadState: 'error',
        message: productVoiceSettingsErrorCopy(error)
      }))
    })

    return () => {
      active = false
    }
  }, [client])

  const loadManagedProfiles = useCallback(async (reason = 'Load available voice settings') => {
    if (!adminActionReady) return
    setState((current) => ({
      ...current,
      managementState: 'loading',
      message: null
    }))
    try {
      const result = await client.admin.execute<{ profiles?: TtsVoiceProfile[] }>({
        methodId: TTS_MANAGE_METHODS.listProfiles,
        payload: { include_unavailable: true },
        reason: adminReasonFor(reason, adminReasonValue),
        reauthConfirmed: adminReviewConfirmed,
        affectedResources: ['voice-profiles'],
        path: routePath('TTS', 'ListVoiceProfiles')
      })
      setState((current) => ({
        ...current,
        profiles: result.data.profiles ?? [],
        managementState: 'ready',
        message: null
      }))
    } catch (error) {
      setState((current) => ({
        ...current,
        profiles: [],
        managementState: 'limited',
        message: voiceSettingsManagementCopy(error)
      }))
    }
  }, [adminActionReady, adminReasonValue, adminReviewConfirmed, client.admin])

  useEffect(() => refresh(), [refresh])

  const managedProfiles = useMemo(() => state.profiles.map((profile, index) => toManagedVoice(profile, index, state.capabilities)), [state.profiles, state.capabilities])
  const voiceRows = useMemo(() => state.voices.map((voice, index) => toVoiceRow(voice, index, state.capabilities)), [state.voices, state.capabilities])
  const readyLanguages = useMemo(() => languageList(state.capabilities?.ready_languages), [state.capabilities])
  const canShowInstall = state.managementState === 'ready'
  const actionPending = pendingActionKey !== null || state.managementState === 'loading'

  async function installProfile(profile: ManagedVoice) {
    if (!profile.installable || actionPending || !adminActionReady) return
    const actionKey = actionKeyFor('install', profile.voiceId)
    setInstallingVoiceId(profile.voiceId)
    setPendingActionKey(actionKey)
    setInstallMessage(null)
    try {
      const result = await runVoiceAdminMutation<InstallStatus>(client, {
        methodId: TTS_MANAGE_METHODS.install,
        payload: {
          voice_id: profile.voiceId,
          expected_revision: profile.revision,
          operation_id: createInstallOperationId()
        },
        reason: adminReasonFor('Add spoken reply voice', adminReasonValue),
        reauthConfirmed: adminReviewConfirmed,
        affectedResources: affectedVoiceResources(profile),
        path: routePath('TTS', 'InstallVoiceProfile')
      })
      setInstallMessage(installOutcomeCopy(result.status))
      if (isInstallSuccess(result.status)) await loadManagedProfiles('Refresh available voice settings')
    } catch (error) {
      setInstallMessage(productVoiceSettingsErrorCopy(error, 'Voice was not added. Try again.'))
    } finally {
      setInstallingVoiceId(null)
      setPendingActionKey(null)
    }
  }

  async function setDefaultProfile(profile: ManagedVoice) {
    if (!profile.canSetDefault || actionPending || !adminActionReady) return
    const actionKey = actionKeyFor('default', profile.voiceId)
    setPendingActionKey(actionKey)
    setMutationMessage('Updating voice choice.')
    try {
      const result = await runVoiceAdminMutation<DefaultStatus>(client, {
        methodId: TTS_MANAGE_METHODS.setDefault,
        payload: {
          voice_id: profile.voiceId,
          expected_revision: profile.revision,
          operation_id: createVoiceOperationId('default')
        },
        reason: adminReasonFor('Update spoken reply voice choice', adminReasonValue),
        reauthConfirmed: adminReviewConfirmed,
        affectedResources: affectedVoiceResources(profile),
        path: routePath('TTS', 'SetDefaultVoice')
      })
      setMutationMessage(defaultOutcomeCopy(result.status))
      if (isDefaultSuccess(result.status)) await loadManagedProfiles('Refresh available voice settings')
    } catch (error) {
      setMutationMessage(productVoiceSettingsErrorCopy(error, 'Voice choice was not changed. Try again.'))
    } finally {
      setPendingActionKey(null)
    }
  }

  async function runConfirmedAction(action: VoiceConfirmation) {
    if (actionPending || !adminActionReady) return
    const actionKey = actionKeyFor(action.kind, action.profile.voiceId)
    setPendingActionKey(actionKey)
    setMutationMessage(action.kind === 'remove' ? 'Removing voice.' : 'Deleting voice.')
    try {
      const result = await runVoiceAdminMutation<RemoveStatus | DeleteStatus>(client, {
        methodId: action.kind === 'remove' ? TTS_MANAGE_METHODS.remove : TTS_MANAGE_METHODS.delete,
        payload: {
          voice_id: action.profile.voiceId,
          expected_revision: action.profile.revision,
          operation_id: createVoiceOperationId(action.kind)
        },
        reason: adminReasonFor(action.kind === 'remove' ? 'Remove spoken reply voice' : 'Delete spoken reply voice', adminReasonValue),
        reauthConfirmed: adminReviewConfirmed,
        affectedResources: affectedVoiceResources(action.profile),
        path: routePath('TTS', action.kind === 'remove' ? 'RemoveVoiceProfile' : 'DeleteVoiceProfile')
      })
      if (action.kind === 'remove') {
        const status = result.status as RemoveStatus
        setMutationMessage(removeOutcomeCopy(status))
        if (isRemoveSuccess(status)) await loadManagedProfiles('Refresh available voice settings')
      } else {
        const status = result.status as DeleteStatus
        setMutationMessage(deleteOutcomeCopy(status))
        if (isDeleteSuccess(status)) await loadManagedProfiles('Refresh available voice settings')
      }
      setConfirmAction(null)
    } catch (error) {
      setMutationMessage(productVoiceSettingsErrorCopy(error, action.kind === 'remove' ? 'Voice was not removed. Try again.' : 'Voice was not deleted. Try again.'))
    } finally {
      setPendingActionKey(null)
    }
  }

  return (
    <div className="flex flex-col gap-4 py-4">
      <StatStrip
        ariaLabel="Spoken reply summary"
        items={[
          {
            label: 'Readiness',
            value: readinessLabel(state.capabilities),
            caption: state.capabilities?.ready ? 'Spoken replies can use available voices.' : 'Spoken replies need attention.',
            tone: state.capabilities?.ready ? 'success' : 'warning'
          },
          {
            label: 'Languages',
            value: readyLanguages.length > 0 ? readyLanguages.join(', ') : 'None ready',
            caption: readyLanguages.length > 0 ? 'Available for spoken replies.' : 'Add a voice to start.'
          },
          {
            label: 'Voices',
            value: String(state.voices.length),
            caption: state.managementState === 'limited' ? 'Voice choices loaded. Editing needs access.' : 'Voice choices available.'
          }
        ]}
      />

      {state.message ? (
        <p role={state.loadState === 'error' ? 'alert' : 'status'} className="rounded-lg border border-border bg-muted/30 px-3 py-2 text-sm">
          {state.message}
        </p>
      ) : null}
      {installMessage ? (
        <p role="status" className="rounded-lg border border-border bg-muted/30 px-3 py-2 text-sm">
          {installMessage}
        </p>
      ) : null}
      {mutationMessage ? (
        <p role="status" className="rounded-lg border border-border bg-muted/30 px-3 py-2 text-sm">
          {mutationMessage}
        </p>
      ) : null}

      <Card title="Spoken reply voices" description="Voices Aurora can use for spoken replies.">
        <div className="flex flex-col gap-3">
          {state.loadState === 'loading' ? <p className="text-sm text-muted-foreground">Loading voice choices.</p> : null}
          {voiceRows.map((voice) => (
            <div key={voice.voiceId} className="flex flex-col gap-2 border-b border-border/60 pb-3 last:border-0 last:pb-0 sm:flex-row sm:items-center sm:justify-between">
              <div className="min-w-0">
                <p className="text-sm font-medium">{voice.label}</p>
                <p className="text-xs text-muted-foreground">{voice.detail}</p>
              </div>
              <Badge variant={voice.ready ? 'default' : 'secondary'}>{voice.ready ? 'Ready' : 'Needs setup'}</Badge>
            </div>
          ))}
          {voiceRows.length === 0 && state.loadState !== 'loading' ? (
            <p className="text-sm text-muted-foreground">No voice choices are available yet.</p>
          ) : null}
        </div>
      </Card>

      <Card title="Voices available to Aurora" description="Voices Aurora can use or add for spoken replies.">
        <div className="flex flex-col gap-3">
          <div className="flex flex-col gap-2 rounded-md border border-border/70 p-3">
            <label className="flex flex-col gap-1 text-sm">
              <span className="font-medium">Reason</span>
              <input
                className="h-9 rounded-md border border-input bg-background px-3 text-sm"
                value={adminReason}
                onChange={(event) => setAdminReason(event.currentTarget.value)}
                aria-label="Voice change reason"
                disabled={actionPending}
              />
            </label>
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={adminReviewConfirmed}
                onChange={(event) => setAdminReviewConfirmed(event.currentTarget.checked)}
                disabled={actionPending || adminReasonValue.length === 0}
              />
              <span>I confirm these voice changes are allowed.</span>
            </label>
          </div>
          {state.managementState === 'locked' ? (
            <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
              <p className="text-sm text-muted-foreground">Show available voices before adding or changing spoken reply voices.</p>
              <Button
                variant="outline"
                className="h-8 px-3 text-xs"
                onClick={() => void loadManagedProfiles()}
                disabled={actionPending || !adminActionReady}
              >
                Show available voices
              </Button>
            </div>
          ) : null}
          {state.managementState === 'loading' ? <p className="text-sm text-muted-foreground">Loading available voices.</p> : null}
          {state.managementState === 'limited' ? (
            <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
              <p className="text-sm text-muted-foreground">Available voices could not be loaded. Review access and try again.</p>
              <Button
                variant="outline"
                className="h-8 px-3 text-xs"
                onClick={() => void loadManagedProfiles()}
                disabled={actionPending || !adminActionReady}
              >
                Try again
              </Button>
            </div>
          ) : null}
          {managedProfiles.map((profile) => (
            <div key={profile.voiceId} className="flex flex-col gap-2 border-b border-border/60 pb-3 last:border-0 last:pb-0 sm:flex-row sm:items-center sm:justify-between">
              <div className="min-w-0">
                <p className="text-sm font-medium">{profile.label}</p>
                <p className="text-xs text-muted-foreground">{profile.detail}</p>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <Badge variant={profile.ready ? 'default' : 'secondary'}>{profile.badge}</Badge>
                {canShowInstall && profile.canSetDefault ? (
                  <Button
                    variant="outline"
                    className="h-8 px-3 text-xs"
                    onClick={() => void setDefaultProfile(profile)}
                    disabled={actionPending || !adminActionReady}
                  >
                    {pendingActionKey === actionKeyFor('default', profile.voiceId) ? 'Updating' : 'Use by default'}
                  </Button>
                ) : null}
                {canShowInstall && profile.installable ? (
                  <Button
                    variant="outline"
                    className="h-8 px-3 text-xs"
                    onClick={() => void installProfile(profile)}
                    disabled={actionPending || !adminActionReady}
                  >
                    {installingVoiceId === profile.voiceId ? 'Adding' : 'Add voice'}
                  </Button>
                ) : null}
                {canShowInstall && profile.canRemove ? (
                  <Button
                    variant="outline"
                    className="h-8 px-3 text-xs"
                    onClick={() => setConfirmAction({ kind: 'remove', profile })}
                    disabled={actionPending || !adminActionReady}
                  >
                    Remove
                  </Button>
                ) : null}
                {canShowInstall && profile.canDelete ? (
                  <Button
                    variant="danger"
                    className="h-8 px-3 text-xs"
                    onClick={() => setConfirmAction({ kind: 'delete', profile })}
                    disabled={actionPending || !adminActionReady}
                  >
                    Delete
                  </Button>
                ) : null}
              </div>
            </div>
          ))}
          {managedProfiles.length === 0 && state.managementState === 'ready' ? (
            <p className="text-sm text-muted-foreground">No additional voices are available yet.</p>
          ) : null}
        </div>
      </Card>

      <AlertDialog open={confirmAction !== null} onOpenChange={(open) => {
        if (!open && !actionPending) setConfirmAction(null)
      }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{confirmAction?.kind === 'delete' ? 'Delete voice?' : 'Remove voice?'}</AlertDialogTitle>
            <AlertDialogDescription>
              {confirmAction?.kind === 'delete'
                ? 'This voice will no longer be available in Aurora.'
                : 'Aurora will stop using this added voice until it is added again.'}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={actionPending}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              variant={confirmAction?.kind === 'delete' ? 'destructive' : 'default'}
              disabled={actionPending || confirmAction === null || !adminActionReady}
              onClick={() => {
                if (confirmAction) void runConfirmedAction(confirmAction)
              }}
            >
              {pendingActionKey && confirmAction ? (confirmAction.kind === 'delete' ? 'Deleting' : 'Removing') : 'Confirm'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
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

async function runVoiceAdminMutation<TStatus extends string>(
  client: AuroraClient,
  input: {
    methodId: VoiceManageMutationMethodId
    payload: VoiceManagePayload
    reason: string
    reauthConfirmed: boolean
    affectedResources: string[]
    path: string
  }
): Promise<MutationOutput<TStatus>> {
  const result = await client.admin.execute<MutationOutput<TStatus>>({
    methodId: input.methodId,
    payload: input.payload,
    reason: input.reason,
    reauthConfirmed: input.reauthConfirmed,
    affectedResources: input.affectedResources,
    path: input.path
  })
  return result.data
}

function affectedVoiceResources(profile: Pick<ManagedVoice, 'voiceId'>): string[] {
  return [`voice-profile:${profile.voiceId}`]
}

function adminReasonFor(action: string, userReason: string): string {
  return `${action}: ${userReason}`
}

interface VoiceRow {
  voiceId: string
  label: string
  detail: string
  ready: boolean
}

interface ManagedVoice extends VoiceRow {
  revision: string
  installable: boolean
  canDelete: boolean
  canRemove: boolean
  canSetDefault: boolean
  badge: string
}

interface VoiceConfirmation {
  kind: 'delete' | 'remove'
  profile: ManagedVoice
}

function toVoiceRow(voice: TtsVoice, index: number, capabilities: TtsCapabilities | null): VoiceRow {
  const languages = languageListForPacks(capabilities, voice.compatible_language_pack_ids)
  return {
    voiceId: voice.voice_id,
    label: safeVoiceText(voice.display_name, `Voice option ${index + 1}`),
    detail: languages.length > 0 ? `Works with ${languages.join(', ')}.` : 'Language details are unavailable.',
    ready: voice.ready === true
  }
}

function toManagedVoice(profile: TtsVoiceProfile, index: number, capabilities: TtsCapabilities | null): ManagedVoice {
  const languages = languageListForPacks(capabilities, profile.compatible_language_pack_ids)
  const installed = profile.installed === true
  const ready = profile.ready === true
  const isDefault = profile.default === true
  return {
    voiceId: profile.voice_id,
    revision: profile.revision,
    label: safeVoiceText(profile.display_name, `Available voice ${index + 1}`),
    detail: managedVoiceDetail(installed, ready, isDefault, languages),
    ready,
    installable: canInstallProfile(profile, capabilities),
    canDelete: canDeleteProfile(profile),
    canRemove: canRemoveProfile(profile),
    canSetDefault: canSetDefaultProfile(profile),
    badge: isDefault ? 'Default' : ready ? 'Ready' : installed ? 'Needs setup' : 'Available to add'
  }
}

function canInstallProfile(profile: TtsVoiceProfile, capabilities: TtsCapabilities | null): boolean {
  if (profile.installed === true) return false
  if (profile.enabled === false) return false
  if (profile.kind !== 'standard') return false
  if (!capabilities) return false
  const supportedPacks = new Set([...(capabilities.supported_language_pack_ids ?? []), ...(capabilities.installed_language_pack_ids ?? [])])
  const compatible = profile.compatible_language_pack_ids ?? []
  return compatible.length === 0 || compatible.some((packId) => supportedPacks.has(packId))
}

function canSetDefaultProfile(profile: TtsVoiceProfile): boolean {
  return profile.enabled !== false && profile.installed === true && profile.ready === true && profile.default !== true
}

function canRemoveProfile(profile: TtsVoiceProfile): boolean {
  return profile.enabled !== false && profile.kind === 'standard' && profile.installed === true && profile.default !== true && profile.active !== true
}

function canDeleteProfile(profile: TtsVoiceProfile): boolean {
  return profile.enabled !== false && profile.kind === 'cloned' && profile.default !== true && profile.active !== true
}

function managedVoiceDetail(installed: boolean, ready: boolean, isDefault: boolean, languages: string[]): string {
  const languageCopy = languages.length > 0 ? ` ${languages.join(', ')}.` : ''
  if (isDefault) return `Used by default for spoken replies.${languageCopy}`
  if (ready) return `Ready for spoken replies.${languageCopy}`
  if (installed) return `Available but not ready yet.${languageCopy}`
  return `Can be added for spoken replies.${languageCopy}`
}

function readinessLabel(capabilities: TtsCapabilities | null): string {
  if (!capabilities) return 'Checking'
  if (capabilities.ready) return 'Ready'
  if (capabilities.model_status === 'loading') return 'Starting'
  return 'Needs setup'
}

function languageList(values: readonly string[] | null | undefined): string[] {
  const labels: Record<string, string> = {
    de: 'German',
    en: 'English',
    es: 'Spanish',
    fr: 'French',
    it: 'Italian',
    ja: 'Japanese',
    ko: 'Korean',
    pt: 'Portuguese',
    zh: 'Chinese'
  }
  return [...new Set(values ?? [])].map((value) => labels[value] ?? null).filter((value): value is string => Boolean(value))
}

function languageListForPacks(capabilities: TtsCapabilities | null, packIds: readonly string[] | null | undefined): string[] {
  if (!capabilities || !packIds || packIds.length === 0) return []
  const packs = new Set(packIds)
  return languageList(
    capabilities.resident_language_packs
      ?.filter((pack) => packs.has(pack.pack_id))
      .flatMap((pack) => pack.ready_languages ?? [])
  )
}

function safeVoiceText(value: unknown, fallback: string): string {
  if (typeof value !== 'string') return fallback
  const compact = value.trim().replace(/\s+/gu, ' ')
  if (!compact || compact.length > 80) return fallback
  if (findForbiddenProductionCopyTerms(compact).length > 0) return fallback
  if (/^(?:standard|clone):/iu.test(compact)) return fallback
  if (/[a-z0-9]+(?:[._:-][a-z0-9]+){2,}/iu.test(compact)) return fallback
  return compact
}

function productVoiceSettingsErrorCopy(error: unknown, backup = 'Voice settings could not be loaded. Try again.'): string {
  const copy = safeErrorCopy(error)
  if (!copy.title) return backup
  if (!copy.action || copy.title.toLowerCase().includes(copy.action.toLowerCase())) return copy.title
  return `${copy.title}. ${copy.action}.`
}

function voiceSettingsManagementCopy(error: unknown): string {
  const copy = safeErrorCopy(error)
  if (copy.title.includes('Permission')) return 'Available voices need access before they can be shown.'
  if (copy.title.includes('cannot use')) return 'Available voices are not shown on this Aurora version.'
  return 'Available voices could not be loaded. Review access and try again.'
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

function isInstallSuccess(status: InstallStatus): boolean {
  return status === 'installed' || status === 'queued' || status === 'unchanged'
}

function isDefaultSuccess(status: DefaultStatus): boolean {
  return status === 'activated' || status === 'drained'
}

function isRemoveSuccess(status: RemoveStatus): boolean {
  return status === 'removed' || status === 'drained' || status === 'unchanged' || status === 'not_found'
}

function isDeleteSuccess(status: DeleteStatus): boolean {
  return status === 'deleted' || status === 'not_found'
}

function createInstallOperationId(): string {
  return createVoiceOperationId('install')
}

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

function actionKeyFor(kind: VoiceMutationKind, voiceId: string): string {
  return `${kind}:${voiceId}`
}
