'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import {
  type AuroraClient,
} from '@aurora/client'
import {
  LanguageOptionsCard,
  SpokenReplyVoicesCard,
  VoiceSettingsNotices,
  VoiceSettingsSummary,
} from './voice-settings-server-sections'
import { LocalSpeechSettingsSection } from './voice-settings-local-speech-section'
import {
  confirmedWakePhraseSelection,
  displayedSpeechRow,
  filterSpeechRowsForLanguage,
  languageCodeFromText,
  localSpeechActionKey,
  localSpeechSelectionForRow,
  selectedSpeechRow,
  speechLanguageChoices,
  speechRowChoiceOptions,
  toBrowserSpeechAssetRows,
  toLocalSpeechAssetRows,
  voiceLanguageChoices,
  wakePhraseOptionsFor,
  type LocalSpeechAssetRow,
  type WakePhraseOption,
} from './voice-settings-local-speech-model'
export { primaryLanguageFromConfig } from './voice-settings-local-speech-model'
import { SearchableChoice } from './voice-settings-searchable-choice'
import { ManagedVoicesSection } from './voice-settings-managed-voices-section'
import {
  languageList,
  readinessLabel,
  spokenReplyReadinessCaption,
  toManagedVoice,
  toPackRows,
  toVoiceRow,
} from './voice-settings-managed-voice-model'
import { surfaceCanConfigureBackgroundWake, type AuroraSurfaceProfile } from './platform-surface'
import { AuroraQueryProvider, useAuroraQueryScope, useAuroraQueryScopeKey } from './query'
import {
  AUTO_LOCAL_VOICE_LANGUAGE,
  DEFAULT_LOCAL_PRIMARY_LANGUAGE,
  resolveLocalSpeechLanguagePolicy,
  type AuroraLocalSpeechLanguagePrefs,
  type AuroraLocalSpeechPreferencesSave,
  type AuroraLocalSpeechSelectionProfile,
  type AuroraRuntimeProfileV2,
} from './runtime-profile'
import type { AuroraLocalSpeechCatalogPort } from './browser-speech-pack'
import { useSpeechCatalog } from './use-speech-catalog'
import { actionKeyFor, useVoiceSettingsOperations } from './use-voice-settings-operations'


type VoiceScopeToken = { scopeKey: string; generation: number; mounted: boolean }

export interface VoiceSettingsViewProps {
  client: AuroraClient
  runtimeProfile?: AuroraRuntimeProfileV2 | null | undefined
  surfaceProfile?: AuroraSurfaceProfile | null | undefined
  localSpeechCatalog?: AuroraLocalSpeechCatalogPort | null | undefined
  onLocalSpeechSelectionConfirmed?: AuroraLocalSpeechPreferencesSave | undefined
  /** Hide on-device pack and wake-phrase sections when embedding server spoken-reply controls outside local Settings. */
  hideOnDeviceSections?: boolean | undefined
  /** Hide server spoken-reply catalog/admin controls when embedding this view in This-device Settings. */
  hideServerVoiceSections?: boolean | undefined
}

export function VoiceSettingsView(props: VoiceSettingsViewProps) {
  const hasQueryScope = useAuroraQueryScope()
  if (hasQueryScope) return <VoiceSettingsViewInner {...props} />
  return (
    <AuroraQueryProvider client={props.client} surfaceProfile={props.surfaceProfile ?? null}>
      <VoiceSettingsViewInner {...props} />
    </AuroraQueryProvider>
  )
}

function VoiceSettingsViewInner({
  client,
  runtimeProfile = null,
  surfaceProfile: providedSurfaceProfile = null,
  localSpeechCatalog = null,
  onLocalSpeechSelectionConfirmed,
  hideOnDeviceSections = false,
  hideServerVoiceSections = false
}: VoiceSettingsViewProps) {
  const [wakePhraseMessage, setWakePhraseMessage] = useState<string | null>(null)
  const [referenceEditor, setReferenceEditor] = useState<LocalSpeechAssetRow | null>(null)
  const [referenceFile, setReferenceFile] = useState<File | null>(null)
  const referenceFileInputRef = useRef<HTMLInputElement | null>(null)
  const [speechLanguage, setSpeechLanguage] = useState<string | null>(null)
  const [voiceLanguage, setVoiceLanguage] = useState<string | null>(null)
  const voiceQueryScopeKey = JSON.stringify(useAuroraQueryScopeKey())
  const activeVoiceScopeRef = useRef({ scopeKey: voiceQueryScopeKey, generation: 0, mounted: true })
  if (activeVoiceScopeRef.current.scopeKey !== voiceQueryScopeKey) {
    activeVoiceScopeRef.current = {
      scopeKey: voiceQueryScopeKey,
      generation: activeVoiceScopeRef.current.generation + 1,
      mounted: true,
    }
  }
  const [adminReason, setAdminReason] = useState('Manage spoken reply voices')
  const [adminReviewConfirmed, setAdminReviewConfirmed] = useState(false)
  const adminReasonValue = adminReason.trim()
  const adminActionReady = adminReviewConfirmed && adminReasonValue.length > 0

  useEffect(() => {
    activeVoiceScopeRef.current.mounted = true
    setAdminReason('Manage spoken reply voices')
    setAdminReviewConfirmed(false)
    return () => {
      activeVoiceScopeRef.current = {
        ...activeVoiceScopeRef.current,
        generation: activeVoiceScopeRef.current.generation + 1,
        mounted: false,
      }
    }
  }, [voiceQueryScopeKey])

  function currentVoiceScopeToken() {
    return { ...activeVoiceScopeRef.current }
  }

  function isCurrentVoiceScope(token: VoiceScopeToken): boolean {
    const current = activeVoiceScopeRef.current
    return current.mounted && current.scopeKey === token.scopeKey && current.generation === token.generation
  }

  const {
    state,
    surfaceProfile,
    canManageLocalSpeechAssets,
    browserCatalogItems,
    referenceProfiles,
    setReferenceProfiles,
    loadManagedProfiles,
    invalidateVoiceServerData,
  } = useSpeechCatalog({
    client,
    runtimeProfile,
    surfaceProfile: providedSurfaceProfile,
    localSpeechCatalog,
    onLocalSpeechSelectionConfirmed,
    adminActionReady,
    adminReasonValue,
    adminReviewConfirmed,
  })

  const {
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
    transferMessage,
    exportCloneVoice,
    importCloneVoice,
    installProfile,
    runConfirmedAction,
    setDefaultProfile,
  } = useVoiceSettingsOperations({
    client,
    managementLoading: state.managementState === 'loading',
    adminReasonValue,
    adminReviewConfirmed,
    adminActionReady,
    capabilities: state.capabilities,
    packs: state.packs,
    scopeKey: voiceQueryScopeKey,
    currentVoiceScopeToken,
    isCurrentVoiceScope,
    invalidateVoiceServerData,
    persistConfirmedLocalSpeechSelection,
  })

  const managedProfiles = useMemo(() => state.profiles.map((profile, index) => toManagedVoice(profile, index, state.capabilities, state.packs)), [state.profiles, state.capabilities, state.packs])
  const voiceRows = useMemo(() => state.voices.map((voice, index) => toVoiceRow(voice, index, state.capabilities)), [state.voices, state.capabilities])
  const packRows = useMemo(() => toPackRows(state.capabilities, state.packs), [state.capabilities, state.packs])
  const canConfigureBackgroundWake = surfaceCanConfigureBackgroundWake(surfaceProfile)
  const localSpeechRows = useMemo(
    () => {
      const rows = canManageLocalSpeechAssets && browserCatalogItems.length > 0
        ? toBrowserSpeechAssetRows(browserCatalogItems, runtimeProfile?.localNode.localSpeechSelection ?? null, referenceProfiles, false)
        : canManageLocalSpeechAssets
          ? toLocalSpeechAssetRows(state.capabilities, surfaceProfile.localSpeechPack)
          : []
      return canConfigureBackgroundWake ? rows : rows.filter((row) => row.task !== 'kws')
    },
    [browserCatalogItems, canConfigureBackgroundWake, canManageLocalSpeechAssets, referenceProfiles, runtimeProfile?.localNode.localSpeechSelection, state.capabilities, surfaceProfile.localSpeechPack],
  )
  const browserTtsRows = useMemo(
    () => canManageLocalSpeechAssets
      ? toBrowserSpeechAssetRows(browserCatalogItems, runtimeProfile?.localNode.localSpeechSelection ?? null, referenceProfiles, true)
      : [],
    [browserCatalogItems, canManageLocalSpeechAssets, referenceProfiles, runtimeProfile?.localNode.localSpeechSelection, surfaceProfile.localSpeechPack],
  )
  const readyLanguages = useMemo(() => languageList(state.capabilities?.ready_languages), [state.capabilities])
  const canShowInstall = state.managementState === 'ready'
  const canTransferCloneVoices = state.capabilities?.cloning === true
  const languageCatalogMessage = state.languageCatalogState === 'limited'
    ? 'Language options could not be loaded. Review access and try again.'
    : null
  const wakePhraseOptions = useMemo(() => wakePhraseOptionsFor(runtimeProfile), [runtimeProfile])
  const selectedWakePhraseId = runtimeProfile?.localNode.localSpeechSelection?.wakePhrase?.phraseId ?? null
  const canChooseWakePhrase = Boolean(
    canConfigureBackgroundWake
    && onLocalSpeechSelectionConfirmed
    && runtimeProfile?.nodeMode === 'mesh-node'
    && surfaceProfile.localSpeechPack.canRunLocalKws
    && runtimeProfile.localNode.localSpeechSelection?.kws
  )
  const allLocalSpeechRows = useMemo(
    () => [...localSpeechRows, ...browserTtsRows],
    [browserTtsRows, localSpeechRows],
  )
  const speechLanguageOptions = useMemo(
    () => speechLanguageChoices(allLocalSpeechRows, speechLanguage),
    [allLocalSpeechRows, speechLanguage],
  )
  const voiceLanguageOptions = useMemo(
    () => voiceLanguageChoices(allLocalSpeechRows, voiceLanguage, speechLanguage),
    [allLocalSpeechRows, speechLanguage, voiceLanguage],
  )
  const preferredSpeechLanguage = resolveLocalSpeechLanguagePolicy(
    speechLanguage,
    voiceLanguage,
  ).modelLanguage
  const currentLocalSpeechSelection = runtimeProfile?.localNode.localSpeechSelection ?? null
  const selectedListeningStart = useMemo(
    () => selectedSpeechRow(localSpeechRows.filter((row) => row.task === 'vad'), currentLocalSpeechSelection?.vad, referenceProfiles),
    [currentLocalSpeechSelection?.vad, localSpeechRows, referenceProfiles],
  )
  const selectedWakeWords = useMemo(
    () => selectedSpeechRow(localSpeechRows.filter((row) => row.task === 'kws'), currentLocalSpeechSelection?.kws, referenceProfiles),
    [currentLocalSpeechSelection?.kws, localSpeechRows, referenceProfiles],
  )
  const selectedTranscription = useMemo(
    () => selectedSpeechRow(localSpeechRows.filter((row) => row.task === 'stt'), currentLocalSpeechSelection?.stt, referenceProfiles),
    [currentLocalSpeechSelection?.stt, localSpeechRows, referenceProfiles],
  )
  const selectedSpokenVoice = useMemo(
    () => selectedSpeechRow(browserTtsRows, currentLocalSpeechSelection?.tts, referenceProfiles),
    [browserTtsRows, currentLocalSpeechSelection?.tts, referenceProfiles],
  )
  const listeningStartRows = useMemo(
    () => filterSpeechRowsForLanguage(localSpeechRows.filter((row) => row.task === 'vad'), preferredSpeechLanguage, selectedListeningStart),
    [localSpeechRows, preferredSpeechLanguage, selectedListeningStart],
  )
  const wakeWordRows = useMemo(
    () => canConfigureBackgroundWake
      ? filterSpeechRowsForLanguage(localSpeechRows.filter((row) => row.task === 'kws'), preferredSpeechLanguage, selectedWakeWords)
      : [],
    [canConfigureBackgroundWake, localSpeechRows, preferredSpeechLanguage, selectedWakeWords],
  )
  const transcriptionRows = useMemo(
    () => filterSpeechRowsForLanguage(localSpeechRows.filter((row) => row.task === 'stt'), preferredSpeechLanguage, selectedTranscription),
    [localSpeechRows, preferredSpeechLanguage, selectedTranscription],
  )
  const spokenVoiceRows = useMemo(
    () => filterSpeechRowsForLanguage(browserTtsRows, preferredSpeechLanguage, selectedSpokenVoice),
    [browserTtsRows, preferredSpeechLanguage, selectedSpokenVoice],
  )
  const defaultListeningStart = displayedSpeechRow(selectedListeningStart, listeningStartRows)
  const defaultWakeWords = displayedSpeechRow(selectedWakeWords, wakeWordRows)
  const defaultTranscription = displayedSpeechRow(selectedTranscription, transcriptionRows)
  const defaultSpokenVoice = displayedSpeechRow(selectedSpokenVoice, spokenVoiceRows)
  const showLocalSpeechEditor = !hideOnDeviceSections

  useEffect(() => {
    const stored = languageCodeFromText(runtimeProfile?.localNode.primaryLanguage ?? '')
    if (stored) {
      setSpeechLanguage(stored)
      return
    }
    setSpeechLanguage((current) => current ?? DEFAULT_LOCAL_PRIMARY_LANGUAGE)
  }, [runtimeProfile?.localNode.primaryLanguage])

  useEffect(() => {
    const stored = runtimeProfile?.localNode.voiceLanguage
    if (typeof stored === 'string' && stored.trim()) {
      const normalized = stored.trim().toLowerCase().replaceAll('_', '-')
      if (normalized === AUTO_LOCAL_VOICE_LANGUAGE) {
        setVoiceLanguage(AUTO_LOCAL_VOICE_LANGUAGE)
        return
      }
      const code = languageCodeFromText(stored)
      if (code) {
        setVoiceLanguage(code)
        return
      }
    }
    setVoiceLanguage((current) => current ?? AUTO_LOCAL_VOICE_LANGUAGE)
  }, [runtimeProfile?.localNode.voiceLanguage])

  async function selectLocalSpeechAsset(row: LocalSpeechAssetRow): Promise<void> {
    if (actionPending || !canManageLocalSpeechAssets) return
    const scopeToken = currentVoiceScopeToken()
    if (row.needsReferenceProfile) {
      if (isCurrentVoiceScope(scopeToken)) openReferenceEditor(row)
      return
    }
    const actionKey = localSpeechActionKey(row)
    setPendingActionKey(actionKey)
    setMutationMessage(row.ready ? `Updating ${row.copy.noun.toLowerCase()} choice.` : `Adding ${row.copy.noun.toLowerCase()}.`)
    try {
      if (row.selection) {
        if (!localSpeechCatalog?.available) {
          if (isCurrentVoiceScope(scopeToken)) setMutationMessage(`${row.copy.noun} could not be added. Try again.`)
          return
        }
        await localSpeechCatalog.select({
          selection: row.selection,
          onProgress: (progress) => {
            if (!isCurrentVoiceScope(scopeToken)) return
            if (progress.state === 'downloading') {
              const pct = progress.totalBytes && progress.totalBytes > 0
                ? Math.floor(((progress.receivedBytes ?? 0) / progress.totalBytes) * 100)
                : null
              setMutationMessage(pct !== null ? `Adding ${row.copy.noun.toLowerCase()} (${pct}%).` : `Adding ${row.copy.noun.toLowerCase()}.`)
              return
            }
            setMutationMessage(progress.state === 'ready'
              ? `${row.copy.noun} added.`
            : `Adding ${row.copy.noun.toLowerCase()}.`)
          }
        })
        if (!isCurrentVoiceScope(scopeToken)) return
        const ok = await persistConfirmedLocalSpeechSelection(localSpeechSelectionForRow(row), scopeToken)
        if (!isCurrentVoiceScope(scopeToken)) return
        setMutationMessage(ok
          ? `${row.copy.noun} choice updated.`
          : `${row.copy.noun} choice was not changed. Try again.`)
        return
      }
      const ok = await persistConfirmedLocalSpeechSelection(localSpeechSelectionForRow(row), scopeToken)
      if (!isCurrentVoiceScope(scopeToken)) return
      setMutationMessage(ok
        ? `${row.copy.noun} choice updated.`
        : `${row.copy.noun} choice was not changed. Try again.`)
    } catch {
      if (isCurrentVoiceScope(scopeToken)) setMutationMessage(`${row.copy.noun} choice was not changed. Try again.`)
    } finally {
      if (isCurrentVoiceScope(scopeToken)) setPendingActionKey(null)
    }
  }

  function selectLocalSpeechAssetById(rows: readonly LocalSpeechAssetRow[], id: string): Promise<void> {
    const row = rows.find((candidate) => localSpeechActionKey(candidate) === id)
    if (!row) return Promise.resolve()
    return selectLocalSpeechAsset(row)
  }

  function openReferenceEditor(row: LocalSpeechAssetRow): void {
    setReferenceEditor(row)
    setReferenceFile(null)
    setMutationMessage(null)
  }

  async function saveReferenceVoiceSample(): Promise<void> {
    if (!referenceEditor || actionPending || !localSpeechCatalog?.saveReferenceProfile) return
    const scopeToken = currentVoiceScopeToken()
    const file = referenceFile ?? referenceFileInputRef.current?.files?.[0] ?? null
    if (!file) {
      setMutationMessage('Choose a voice sample.')
      return
    }
    const row = referenceEditor
    const actionKey = localSpeechActionKey(row)
    setPendingActionKey(actionKey)
    setMutationMessage('Saving voice sample.')
    try {
      const audioBytes = new Uint8Array(await file.arrayBuffer())
      if (!isCurrentVoiceScope(scopeToken)) return
      const profile = await localSpeechCatalog.saveReferenceProfile({
        audioBytes,
        filename: file.name,
        mimeType: file.type || undefined,
      })
      if (!isCurrentVoiceScope(scopeToken)) return
      setReferenceProfiles((current) => Object.freeze([profile, ...current.filter((item) => item.id !== profile.id)]))
      const selection = {
        ...(row.selection ?? {
            task: row.task,
            packId: row.packId,
            packVersion: row.revision,
            displayName: row.label,
            voiceId: row.voiceId,
            voiceRevision: row.voiceRevision,
        }),
        referenceProfileId: profile.id,
        referenceProfileSelected: true,
      }
      await localSpeechCatalog.select({
        selection,
        onProgress: (progress) => {
          if (!isCurrentVoiceScope(scopeToken)) return
          if (progress.state === 'downloading') {
            const pct = progress.totalBytes && progress.totalBytes > 0
              ? Math.floor(((progress.receivedBytes ?? 0) / progress.totalBytes) * 100)
              : null
            setMutationMessage(pct !== null ? `Adding voice (${pct}%).` : 'Adding voice.')
            return
          }
          setMutationMessage(progress.state === 'ready' ? 'Voice sample saved.' : 'Adding voice.')
        },
      })
      if (!isCurrentVoiceScope(scopeToken)) return
      const persisted = await persistConfirmedLocalSpeechSelection(
        localSpeechSelectionForRow(row, profile.id),
        scopeToken,
      )
      if (!isCurrentVoiceScope(scopeToken)) return
      if (!persisted) {
        setMutationMessage('Voice sample was saved, but the voice choice was not changed. Try again.')
        return
      }
      setReferenceEditor(null)
      setReferenceFile(null)
      setMutationMessage('Voice sample saved.')
    } catch (error) {
      if (isCurrentVoiceScope(scopeToken)) setMutationMessage(productReferenceSampleErrorCopy(error))
    } finally {
      if (isCurrentVoiceScope(scopeToken)) setPendingActionKey(null)
    }
  }

  async function deleteReferenceVoiceSample(row: LocalSpeechAssetRow): Promise<void> {
    const profileId = row.referenceProfileId
    if (!profileId || actionPending || !localSpeechCatalog?.deleteReferenceProfile) return
    const scopeToken = currentVoiceScopeToken()
    setPendingActionKey(localSpeechActionKey(row))
    setMutationMessage('Removing voice sample.')
    try {
      await localSpeechCatalog.deleteReferenceProfile(profileId)
      if (!isCurrentVoiceScope(scopeToken)) return
      setReferenceProfiles((current) => Object.freeze(current.filter((profile) => profile.id !== profileId)))
      await persistConfirmedLocalSpeechSelection(localSpeechSelectionForRow(row), scopeToken)
      if (!isCurrentVoiceScope(scopeToken)) return
      setMutationMessage('Voice sample removed.')
    } catch {
      if (isCurrentVoiceScope(scopeToken)) setMutationMessage('Voice sample was not removed. Try again.')
    } finally {
      if (isCurrentVoiceScope(scopeToken)) setPendingActionKey(null)
    }
  }

  async function persistConfirmedLocalSpeechSelection(
    selection: AuroraLocalSpeechSelectionProfile | null,
    scopeToken: VoiceScopeToken = currentVoiceScopeToken(),
  ): Promise<boolean> {
    if (!selection) return true
    if (!canManageLocalSpeechAssets || !onLocalSpeechSelectionConfirmed || !isCurrentVoiceScope(scopeToken)) return true
    try {
      await onLocalSpeechSelectionConfirmed(selection)
      return isCurrentVoiceScope(scopeToken)
    } catch {
      return false
    }
  }

  function productReferenceSampleErrorCopy(error: unknown): string {
    const message = error instanceof Error ? error.message : ''
    if (message === 'voice_sample_format') return 'Use a mono 16-bit WAV file.'
    if (message === 'voice_sample_rate') return 'Use a WAV file between 8 kHz and 48 kHz.'
    if (message === 'voice_sample_short') return 'Use a voice sample at least half a second long.'
    if (message === 'voice_sample_long') return 'Use a voice sample shorter than 30 seconds.'
    if (message === 'voice_sample_file') return 'Use a WAV file smaller than 10 MB.'
    return 'Voice sample was not saved. Try again.'
  }

  async function persistLocalSpeechLanguages(
    languages: AuroraLocalSpeechLanguagePrefs,
    scopeToken: VoiceScopeToken = currentVoiceScopeToken(),
  ): Promise<void> {
    if (!onLocalSpeechSelectionConfirmed || !isCurrentVoiceScope(scopeToken)) return
    try {
      await onLocalSpeechSelectionConfirmed({}, languages)
    } catch {
      if (isCurrentVoiceScope(scopeToken)) setMutationMessage('Language was not saved. Try again.')
    }
  }

  function choosePrimaryLanguage(id: string): void {
    const scopeToken = currentVoiceScopeToken()
    setSpeechLanguage(id)
    void persistLocalSpeechLanguages({ primaryLanguage: id }, scopeToken)
  }

  function chooseVoiceLanguage(id: string): void {
    const scopeToken = currentVoiceScopeToken()
    setVoiceLanguage(id)
    void persistLocalSpeechLanguages({ voiceLanguage: id }, scopeToken)
  }

  async function chooseWakePhrase(option: WakePhraseOption): Promise<void> {
    const scopeToken = currentVoiceScopeToken()
    const selection = confirmedWakePhraseSelection(runtimeProfile, option)
    if (!selection || !onLocalSpeechSelectionConfirmed || !isCurrentVoiceScope(scopeToken)) return
    setPendingActionKey(actionKeyFor('default', `wake:${option.phraseId}`))
    setWakePhraseMessage('Updating wake phrase.')
    try {
      await onLocalSpeechSelectionConfirmed(selection)
      if (isCurrentVoiceScope(scopeToken)) setWakePhraseMessage('Wake phrase updated.')
    } catch {
      if (isCurrentVoiceScope(scopeToken)) setWakePhraseMessage('Wake phrase was not changed. Try again.')
    } finally {
      if (isCurrentVoiceScope(scopeToken)) setPendingActionKey(null)
    }
  }

  const showServerVoiceSections = !hideServerVoiceSections

  return (
    <div className="flex flex-col gap-4 py-4">
      {showServerVoiceSections ? (
        <VoiceSettingsSummary
          readiness={readinessLabel(state.capabilities)}
          readinessCaption={spokenReplyReadinessCaption(state.capabilities, surfaceProfile)}
          ready={state.capabilities?.ready === true}
          readyLanguages={readyLanguages}
          voiceCount={state.voices.length}
          managementState={state.managementState}
          loadState={state.loadState}
        />
      ) : null}

      <VoiceSettingsNotices
        loadState={state.loadState}
        messages={[state.message, installMessage, mutationMessage, wakePhraseMessage, transferMessage]}
      />

      {showServerVoiceSections ? (
        <>
          <SpokenReplyVoicesCard loadState={state.loadState} voiceRows={voiceRows} />
          <LanguageOptionsCard
            managementState={state.managementState}
            languageCatalogState={state.languageCatalogState}
            languageCatalogMessage={languageCatalogMessage}
            packRows={packRows}
          />
        </>
      ) : null}

      {showLocalSpeechEditor ? (
        <LocalSpeechSettingsSection
          browserCatalogState={state.browserCatalogState}
          actionPending={actionPending}
          speechLanguageValue={speechLanguage ?? DEFAULT_LOCAL_PRIMARY_LANGUAGE}
          speechLanguageOptions={speechLanguageOptions}
          voiceLanguageValue={voiceLanguage ?? AUTO_LOCAL_VOICE_LANGUAGE}
          voiceLanguageOptions={voiceLanguageOptions}
          listeningStartRows={listeningStartRows}
          wakeWordRows={wakeWordRows}
          transcriptionRows={transcriptionRows}
          spokenVoiceRows={spokenVoiceRows}
          listeningStartOptions={speechRowChoiceOptions(listeningStartRows, actionPending)}
          wakeWordOptions={speechRowChoiceOptions(wakeWordRows, actionPending)}
          transcriptionOptions={speechRowChoiceOptions(transcriptionRows, actionPending)}
          spokenVoiceOptions={speechRowChoiceOptions(spokenVoiceRows, actionPending)}
          defaultListeningStartKey={defaultListeningStart ? localSpeechActionKey(defaultListeningStart) : null}
          defaultWakeWordsKey={defaultWakeWords ? localSpeechActionKey(defaultWakeWords) : null}
          defaultTranscriptionKey={defaultTranscription ? localSpeechActionKey(defaultTranscription) : null}
          defaultSpokenVoiceKey={defaultSpokenVoice ? localSpeechActionKey(defaultSpokenVoice) : null}
          canConfigureBackgroundWake={canConfigureBackgroundWake}
          selectedWakePhraseId={selectedWakePhraseId}
          wakePhraseOptions={wakePhraseOptions}
          canChooseWakePhrase={canChooseWakePhrase}
          selectedSpokenVoice={selectedSpokenVoice}
          referenceEditor={referenceEditor}
          pendingReferenceEditorKey={referenceEditor && pendingActionKey === localSpeechActionKey(referenceEditor) ? pendingActionKey : null}
          localSpeechCatalog={localSpeechCatalog}
          referenceFileInputRef={referenceFileInputRef}
          SearchableChoice={SearchableChoice}
          onChoosePrimaryLanguage={choosePrimaryLanguage}
          onChooseVoiceLanguage={chooseVoiceLanguage}
          onSelectListeningStart={(id) => void selectLocalSpeechAssetById(listeningStartRows, id)}
          onSelectWakeWords={(id) => void selectLocalSpeechAssetById(wakeWordRows, id)}
          onSelectTranscription={(id) => void selectLocalSpeechAssetById(transcriptionRows, id)}
          onSelectSpokenVoice={(id) => void selectLocalSpeechAssetById(spokenVoiceRows, id)}
          onChooseWakePhrase={(id) => {
            const option = wakePhraseOptions.find((candidate) => candidate.phraseId === id)
            if (option) void chooseWakePhrase(option)
          }}
          onOpenReferenceEditor={openReferenceEditor}
          onDeleteReferenceVoiceSample={(row) => void deleteReferenceVoiceSample(row as LocalSpeechAssetRow)}
          onReferenceFileChange={setReferenceFile}
          onSaveReferenceVoiceSample={() => void saveReferenceVoiceSample()}
          onCancelReferenceEditor={() => {
            setReferenceEditor(null)
            setReferenceFile(null)
          }}
        />
      ) : null}

      {showServerVoiceSections ? (
        <ManagedVoicesSection
          adminReason={adminReason}
          adminReasonValueLength={adminReasonValue.length}
          adminReviewConfirmed={adminReviewConfirmed}
          adminActionReady={adminActionReady}
          actionPending={actionPending}
          managementState={state.managementState}
          managedProfiles={managedProfiles}
          canShowInstall={canShowInstall}
          canTransferCloneVoices={canTransferCloneVoices}
          installingVoiceId={installingVoiceId}
          pendingActionKey={pendingActionKey}
          confirmAction={confirmAction}
          importFileInputRef={importFileInputRef}
          onAdminReasonChange={setAdminReason}
          onAdminReviewConfirmedChange={setAdminReviewConfirmed}
          onLoadManagedProfiles={() => void loadManagedProfiles()}
          onSetDefaultProfile={(profile) => void setDefaultProfile(profile)}
          onInstallProfile={(profile) => void installProfile(profile)}
          onRequestConfirmation={setConfirmAction}
          onExportCloneVoice={(profile) => void exportCloneVoice(profile)}
          onImportCloneVoice={() => void importCloneVoice()}
          onImportFileChange={setImportFile}
          onRunConfirmedAction={(action) => void runConfirmedAction(action)}
        />
      ) : null}
    </div>
  )
}
