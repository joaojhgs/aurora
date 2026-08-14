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
import { getAuroraSurfaceProfile } from './platform-surface'

type SpeechLanguage = string
type TtsModelStatus = 'degraded' | 'error' | 'loading' | 'ready' | 'unavailable'
type TtsVoiceKind = 'cloned' | 'standard'
type InstallStatus = 'installed' | 'not_found' | 'queued' | 'rejected' | 'revision_conflict' | 'unchanged'
type RemoveStatus = 'drained' | 'not_found' | 'rejected' | 'removed' | 'revision_conflict' | 'unchanged'
type DefaultStatus = 'activated' | 'drained' | 'not_found' | 'rejected' | 'revision_conflict'
type DeleteStatus = 'deleted' | 'not_found' | 'rejected' | 'revision_conflict'
type PackInstallStatus = 'installed' | 'not_found' | 'queued' | 'rejected' | 'revision_conflict' | 'unchanged'
type PackRemoveStatus = 'not_found' | 'rejected' | 'removed' | 'revision_conflict' | 'unchanged'
type PackDefaultStatus = 'activated' | 'not_found' | 'rejected' | 'revision_conflict'
type VoiceMutationKind = 'default' | 'delete' | 'install' | 'remove'
type PackMutationKind = 'default-pack' | 'install-pack' | 'remove-pack'

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
  active_language_pack_id?: string | null | undefined
  default_language_pack_id?: string | null | undefined
  language_packs?: TtsLanguagePack[] | undefined
  resident_language_packs?: TtsResidentLanguagePack[] | undefined
  engine_capabilities?: {
    vad?: boolean | undefined
    kws?: boolean | undefined
    stt?: boolean | undefined
    tts?: boolean | undefined
  } | undefined
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

interface TtsLanguagePack {
  pack_id: string
  display_name?: string | null | undefined
  revision?: string | null | undefined
  languages?: SpeechLanguage[] | undefined
  ready_languages?: SpeechLanguage[] | undefined
  installed?: boolean | undefined
  ready?: boolean | undefined
  active?: boolean | undefined
  default?: boolean | undefined
  downloadable?: boolean | undefined
  download_progress?: number | null | undefined
  compatible_engine?: boolean | undefined
}

interface VoiceSettingsState {
  capabilities: TtsCapabilities | null
  voices: TtsVoice[]
  profiles: TtsVoiceProfile[]
  packs: TtsLanguagePack[]
  loadState: 'loading' | 'ready' | 'error'
  managementState: 'locked' | 'loading' | 'ready' | 'limited'
  message: string | null
}

const initialVoiceSettingsState: VoiceSettingsState = {
  capabilities: null,
  voices: [],
  profiles: [],
  packs: [],
  loadState: 'loading',
  managementState: 'locked',
  message: null
}

let fallbackInstallOperationSequence = 0
let fallbackVoiceOperationSequence = 0

const TTS_MANAGE_METHODS = {
  install: 'TTS.InstallVoiceProfile',
  installLanguagePack: 'TTS.InstallLanguagePack',
  listLanguagePacks: 'TTS.ListLanguagePacks',
  listProfiles: 'TTS.ListVoiceProfiles',
  removeLanguagePack: 'TTS.RemoveLanguagePack',
  remove: 'TTS.RemoveVoiceProfile',
  setDefaultLanguagePack: 'TTS.SetDefaultLanguagePack',
  setDefault: 'TTS.SetDefaultVoice',
  delete: 'TTS.DeleteVoiceProfile'
} as const

export interface VoiceSettingsViewProps {
  client: AuroraClient
}

export function VoiceSettingsView({ client }: VoiceSettingsViewProps) {
  const [state, setState] = useState<VoiceSettingsState>(initialVoiceSettingsState)
  const [installingVoiceId, setInstallingVoiceId] = useState<string | null>(null)
  const [pendingPackId, setPendingPackId] = useState<string | null>(null)
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
      const packsResult = await client.admin.execute<{ language_packs?: TtsLanguagePack[] }>({
        methodId: TTS_MANAGE_METHODS.listLanguagePacks,
        payload: { include_unavailable: true },
        reason: adminReasonFor(reason, adminReasonValue),
        reauthConfirmed: adminReviewConfirmed,
        affectedResources: ['voice-language-downloads'],
        path: routePath('TTS', 'ListLanguagePacks')
      }).catch(() => null)
      setState((current) => ({
        ...current,
        profiles: result.data.profiles ?? [],
        packs: packsResult?.data.language_packs ?? [],
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
  const packRows = useMemo(() => toPackRows(state.capabilities, state.packs, state.profiles), [state.capabilities, state.packs, state.profiles])
  const readyLanguages = useMemo(() => languageList(state.capabilities?.ready_languages), [state.capabilities])
  const canShowInstall = state.managementState === 'ready'
  const actionPending = pendingActionKey !== null || state.managementState === 'loading'
  const transportKind = client.transport?.kind ?? 'http'
  const surfaceProfile = useMemo(() => getAuroraSurfaceProfile({
    transportKind,
    userAgent: typeof navigator === 'undefined' ? null : navigator.userAgent,
    nodeMode: 'mesh-node',
    runtimeTier: state.capabilities?.ready ? 'lightweight-ts' : 'none',
    enabledCapabilityPacks: ['foreground-voice'],
    localSpeechPackState: state.capabilities?.ready ? 'ready' : state.capabilities?.model_status === 'loading' ? 'downloading' : 'unavailable',
    localSpeechEngineCapabilities: state.capabilities?.engine_capabilities,
  }), [transportKind, state.capabilities])

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

  async function installLanguagePack(pack: ManagedLanguagePack) {
    if (!pack.installable || actionPending || !adminActionReady) return
    const actionKey = actionKeyFor('install-pack', pack.packId)
    setPendingPackId(pack.packId)
    setPendingActionKey(actionKey)
    setMutationMessage('Adding language.')
    try {
      const result = await runPackAdminMutation<PackInstallStatus>(client, {
        methodId: TTS_MANAGE_METHODS.installLanguagePack,
        payload: {
          pack_id: pack.packId,
          ...(pack.revision ? { expected_revision: pack.revision } : {}),
          operation_id: createPackOperationId('install-pack')
        },
        reason: adminReasonFor('Add spoken reply language', adminReasonValue),
        reauthConfirmed: adminReviewConfirmed,
        affectedResources: affectedPackResources(pack),
        path: routePath('TTS', 'InstallLanguagePack')
      })
      setMutationMessage(packInstallOutcomeCopy(result.status))
      if (isPackInstallSuccess(result.status)) await Promise.all([loadManagedProfiles('Refresh available voice settings'), refreshNow()])
    } catch (error) {
      setMutationMessage(productVoiceSettingsErrorCopy(error, 'Language was not added. Try again.'))
    } finally {
      setPendingPackId(null)
      setPendingActionKey(null)
    }
  }

  async function setDefaultLanguagePack(pack: ManagedLanguagePack) {
    if (!pack.canSetDefault || actionPending || !adminActionReady) return
    const actionKey = actionKeyFor('default-pack', pack.packId)
    setPendingPackId(pack.packId)
    setPendingActionKey(actionKey)
    setMutationMessage('Updating language choice.')
    try {
      const result = await runPackAdminMutation<PackDefaultStatus>(client, {
        methodId: TTS_MANAGE_METHODS.setDefaultLanguagePack,
        payload: {
          pack_id: pack.packId,
          ...(pack.revision ? { expected_revision: pack.revision } : {}),
          operation_id: createPackOperationId('default-pack')
        },
        reason: adminReasonFor('Update spoken reply language choice', adminReasonValue),
        reauthConfirmed: adminReviewConfirmed,
        affectedResources: affectedPackResources(pack),
        path: routePath('TTS', 'SetDefaultLanguagePack')
      })
      setMutationMessage(packDefaultOutcomeCopy(result.status))
      if (isPackDefaultSuccess(result.status)) await Promise.all([loadManagedProfiles('Refresh available voice settings'), refreshNow()])
    } catch (error) {
      setMutationMessage(productVoiceSettingsErrorCopy(error, 'Language choice was not changed. Try again.'))
    } finally {
      setPendingPackId(null)
      setPendingActionKey(null)
    }
  }

  async function removeLanguagePack(pack: ManagedLanguagePack) {
    if (!pack.canRemove || actionPending || !adminActionReady) return
    const actionKey = actionKeyFor('remove-pack', pack.packId)
    setPendingPackId(pack.packId)
    setPendingActionKey(actionKey)
    setMutationMessage('Removing language.')
    try {
      const result = await runPackAdminMutation<PackRemoveStatus>(client, {
        methodId: TTS_MANAGE_METHODS.removeLanguagePack,
        payload: {
          pack_id: pack.packId,
          ...(pack.revision ? { expected_revision: pack.revision } : {}),
          operation_id: createPackOperationId('remove-pack')
        },
        reason: adminReasonFor('Remove spoken reply language', adminReasonValue),
        reauthConfirmed: adminReviewConfirmed,
        affectedResources: affectedPackResources(pack),
        path: routePath('TTS', 'RemoveLanguagePack')
      })
      setMutationMessage(packRemoveOutcomeCopy(result.status))
      if (isPackRemoveSuccess(result.status)) await Promise.all([loadManagedProfiles('Refresh available voice settings'), refreshNow()])
    } catch (error) {
      setMutationMessage(productVoiceSettingsErrorCopy(error, 'Language was not removed. Try again.'))
    } finally {
      setPendingPackId(null)
      setPendingActionKey(null)
    }
  }

  function refreshNow(): Promise<void> {
    return Promise.all([
      client.speech.tts.getCapabilities(),
      client.speech.tts.listVoices()
    ]).then(([capabilitiesResult, voicesResult]) => {
      const capabilities = capabilitiesResult.ok ? capabilitiesResult.data.capabilities as TtsCapabilities : null
      const voices = voicesResult.ok ? (voicesResult.data.voices as TtsVoice[] | undefined) ?? [] : []
      setState((current) => ({
        ...current,
        capabilities,
        voices,
        loadState: capabilitiesResult.ok && voicesResult.ok ? 'ready' : 'error'
      }))
    })
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
            caption: surfaceProfile.localSpeechPack.canRunLocalTts ? 'Spoken replies can use available voices.' : 'Spoken replies need attention.',
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

      <Card title="Language downloads" description="Languages Aurora can add when selected.">
        <div className="flex flex-col gap-3">
          {state.managementState === 'locked' ? (
            <p className="text-sm text-muted-foreground">Show available voices to manage language downloads.</p>
          ) : null}
          {packRows.map((pack) => (
            <div key={pack.packId} className="flex flex-col gap-2 border-b border-border/60 pb-3 last:border-0 last:pb-0 sm:flex-row sm:items-center sm:justify-between">
              <div className="min-w-0">
                <p className="text-sm font-medium">{pack.label}</p>
                <p className="text-xs text-muted-foreground">{pack.detail}</p>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <Badge variant={pack.ready ? 'default' : 'secondary'}>{pack.badge}</Badge>
                {canShowInstall && pack.installable ? (
                  <Button
                    variant="outline"
                    className="h-8 px-3 text-xs"
                    onClick={() => void installLanguagePack(pack)}
                    disabled={actionPending || !adminActionReady}
                  >
                    {pendingPackId === pack.packId ? 'Adding' : 'Add and use'}
                  </Button>
                ) : null}
                {canShowInstall && pack.canSetDefault ? (
                  <Button
                    variant="outline"
                    className="h-8 px-3 text-xs"
                    onClick={() => void setDefaultLanguagePack(pack)}
                    disabled={actionPending || !adminActionReady}
                  >
                    {pendingPackId === pack.packId ? 'Updating' : 'Use by default'}
                  </Button>
                ) : null}
                {canShowInstall && pack.canRemove ? (
                  <Button
                    variant="outline"
                    className="h-8 px-3 text-xs"
                    onClick={() => void removeLanguagePack(pack)}
                    disabled={actionPending || !adminActionReady}
                  >
                    {pendingPackId === pack.packId ? 'Removing' : 'Remove'}
                  </Button>
                ) : null}
              </div>
            </div>
          ))}
          {packRows.length === 0 && state.managementState === 'ready' ? (
            <p className="text-sm text-muted-foreground">No language downloads are available yet.</p>
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

interface PackManagePayload extends JsonObject {
  pack_id: string
  expected_revision?: string
  operation_id: string
}

type VoiceManageMutationMethodId =
  | typeof TTS_MANAGE_METHODS.install
  | typeof TTS_MANAGE_METHODS.remove
  | typeof TTS_MANAGE_METHODS.setDefault
  | typeof TTS_MANAGE_METHODS.delete

type PackManageMutationMethodId =
  | typeof TTS_MANAGE_METHODS.installLanguagePack
  | typeof TTS_MANAGE_METHODS.removeLanguagePack
  | typeof TTS_MANAGE_METHODS.setDefaultLanguagePack

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

async function runPackAdminMutation<TStatus extends string>(
  client: AuroraClient,
  input: {
    methodId: PackManageMutationMethodId
    payload: PackManagePayload
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

function affectedPackResources(pack: Pick<ManagedLanguagePack, 'packId'>): string[] {
  return [`voice-language:${pack.packId}`]
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

interface ManagedLanguagePack {
  packId: string
  revision: string | null
  label: string
  detail: string
  ready: boolean
  installable: boolean
  canSetDefault: boolean
  canRemove: boolean
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

function toPackRows(
  capabilities: TtsCapabilities | null,
  catalogPacks: readonly TtsLanguagePack[],
  profiles: readonly TtsVoiceProfile[],
): ManagedLanguagePack[] {
  const rows = new Map<string, TtsLanguagePack>()
  for (const pack of capabilities?.language_packs ?? []) rows.set(pack.pack_id, pack)
  for (const pack of catalogPacks) rows.set(pack.pack_id, { ...rows.get(pack.pack_id), ...pack })
  for (const pack of capabilities?.resident_language_packs ?? []) {
    rows.set(pack.pack_id, {
      ...rows.get(pack.pack_id),
      pack_id: pack.pack_id,
      installed: true,
      ready: true,
      ready_languages: pack.ready_languages,
    })
  }
  for (const packId of capabilities?.supported_language_pack_ids ?? []) {
    rows.set(packId, { ...rows.get(packId), pack_id: packId, downloadable: true })
  }
  for (const packId of capabilities?.installed_language_pack_ids ?? []) {
    rows.set(packId, { ...rows.get(packId), pack_id: packId, installed: true })
  }
  for (const profile of profiles) {
    for (const packId of profile.compatible_language_pack_ids ?? []) {
      rows.set(packId, { ...rows.get(packId), pack_id: packId })
    }
  }

  return Array.from(rows.values())
    .filter((pack) => safePackId(pack.pack_id) !== null)
    .sort((left, right) => packSortLabel(left).localeCompare(packSortLabel(right)))
    .map((pack, index) => toManagedLanguagePack(pack, index, capabilities))
}

function toManagedLanguagePack(
  pack: TtsLanguagePack,
  index: number,
  capabilities: TtsCapabilities | null,
): ManagedLanguagePack {
  const packId = safePackId(pack.pack_id) ?? `voice-language-${index + 1}`
  const languages = languageList(pack.ready_languages ?? pack.languages)
  const installed = pack.installed === true || capabilities?.installed_language_pack_ids?.includes(packId) === true
  const ready = pack.ready === true || capabilities?.resident_language_packs?.some((resident) => resident.pack_id === packId) === true
  const isDefault = pack.default === true || capabilities?.default_language_pack_id === packId
  const active = pack.active === true || capabilities?.active_language_pack_id === packId
  const engineCompatible = pack.compatible_engine !== false
  const downloadProgress = typeof pack.download_progress === 'number' && Number.isFinite(pack.download_progress)
    ? Math.max(0, Math.min(100, pack.download_progress))
    : null
  return {
    packId,
    revision: typeof pack.revision === 'string' && pack.revision.trim() ? pack.revision : null,
    label: safeVoiceText(pack.display_name, languages.length > 0 ? languages.join(', ') : `Language option ${index + 1}`),
    detail: languagePackDetail({ installed, ready, isDefault, active, engineCompatible, downloadProgress, languages }),
    ready,
    installable: !installed && pack.downloadable !== false && engineCompatible,
    canSetDefault: installed && ready && !isDefault && engineCompatible,
    canRemove: installed && !isDefault && !active,
    badge: isDefault ? 'Default' : ready ? 'Ready' : installed ? 'Needs setup' : downloadProgress !== null ? 'Adding' : 'Available to add'
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

function languagePackDetail(input: {
  installed: boolean
  ready: boolean
  isDefault: boolean
  active: boolean
  engineCompatible: boolean
  downloadProgress: number | null
  languages: string[]
}): string {
  const languageCopy = input.languages.length > 0 ? ` ${input.languages.join(', ')}.` : ''
  if (!input.engineCompatible) return `This language cannot run on this device right now.${languageCopy}`
  if (input.downloadProgress !== null && !input.ready) return `Adding language. ${Math.round(input.downloadProgress)} percent complete.${languageCopy}`
  if (input.isDefault) return `Used by default for spoken replies.${languageCopy}`
  if (input.active) return `Currently used for spoken replies.${languageCopy}`
  if (input.ready) return `Ready for spoken replies.${languageCopy}`
  if (input.installed) return `Available but not ready yet.${languageCopy}`
  return `Can be added when selected.${languageCopy}`
}

function readinessLabel(capabilities: TtsCapabilities | null): string {
  if (!capabilities) return 'Checking'
  if (capabilities.ready) return 'Ready'
  if (capabilities.model_status === 'loading') return 'Starting'
  return 'Needs setup'
}

function languageList(values: readonly string[] | null | undefined): string[] {
  return [...new Set(values ?? [])]
    .map((value) => languageLabel(value))
    .filter((value): value is string => Boolean(value))
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

function safePackId(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const compact = value.trim()
  if (!compact || compact.length > 256) return null
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._:-]*$/u.test(compact)) return null
  return compact
}

function packSortLabel(pack: TtsLanguagePack): string {
  return safeVoiceText(pack.display_name, '') || languageList(pack.ready_languages ?? pack.languages).join(', ') || pack.pack_id
}

function languageLabel(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const normalized = normalizeLanguageTag(value)
  if (!normalized) return null
  try {
    const displayNames = typeof Intl !== 'undefined' && 'DisplayNames' in Intl
      ? new Intl.DisplayNames(undefined, { type: 'language' })
      : null
    const label = displayNames?.of(normalized)
    if (label && label !== normalized) return titleCaseLanguage(label)
  } catch {
    // Ignore browser language-display gaps; the normalized tag is still useful.
  }
  return normalized
}

function normalizeLanguageTag(value: string): string | null {
  const compact = value.trim().replaceAll('_', '-')
  if (!/^(?:[a-zA-Z]{2,3}|und)(?:-[a-zA-Z0-9]{2,8}){0,6}$/u.test(compact)) return null
  const parts = compact.split('-')
  return parts.map((part, index) => {
    if (index === 0) return part.toLowerCase()
    if (/^[a-zA-Z]{4}$/u.test(part)) return part[0]!.toUpperCase() + part.slice(1).toLowerCase()
    if (/^[a-zA-Z]{2}$|^\d{3}$/u.test(part)) return part.toUpperCase()
    return part.toLowerCase()
  }).join('-')
}

function titleCaseLanguage(value: string): string {
  return value.replace(/\b[\p{L}]/gu, (match) => match.toLocaleUpperCase())
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

function packInstallOutcomeCopy(status: PackInstallStatus): string {
  if (status === 'installed') return 'Language added and selected.'
  if (status === 'queued') return 'Language will be added soon.'
  if (status === 'unchanged') return 'Language is already available.'
  if (status === 'revision_conflict') return 'Language changed before it could be added. Try again.'
  if (status === 'not_found') return 'Language is no longer available.'
  return 'Language was not added. Try again.'
}

function packDefaultOutcomeCopy(status: PackDefaultStatus): string {
  if (status === 'activated') return 'Language choice updated.'
  if (status === 'revision_conflict') return 'Language changed before it could be selected. Try again.'
  if (status === 'not_found') return 'Language is no longer available.'
  return 'Language choice was not changed. Try again.'
}

function packRemoveOutcomeCopy(status: PackRemoveStatus): string {
  if (status === 'removed') return 'Language removed.'
  if (status === 'unchanged') return 'Language was already removed.'
  if (status === 'revision_conflict') return 'Language changed before it could be removed. Try again.'
  if (status === 'not_found') return 'Language is no longer available.'
  return 'Language was not removed. Try again.'
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

function isPackInstallSuccess(status: PackInstallStatus): boolean {
  return status === 'installed' || status === 'queued' || status === 'unchanged'
}

function isPackDefaultSuccess(status: PackDefaultStatus): boolean {
  return status === 'activated'
}

function isPackRemoveSuccess(status: PackRemoveStatus): boolean {
  return status === 'removed' || status === 'unchanged' || status === 'not_found'
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

function createPackOperationId(kind: PackMutationKind): string {
  const randomId = globalThis.crypto?.randomUUID?.()
  if (randomId) return `voice-${kind}-${randomId}`
  fallbackVoiceOperationSequence = (fallbackVoiceOperationSequence + 1) % Number.MAX_SAFE_INTEGER
  return `voice-${kind}-${Date.now().toString(36)}-${fallbackVoiceOperationSequence.toString(36)}`
}

function actionKeyFor(kind: VoiceMutationKind | PackMutationKind, voiceId: string): string {
  return `${kind}:${voiceId}`
}
