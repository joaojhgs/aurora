import type { ReactNode, RefObject } from 'react'
import { Button, Card, Switch } from './primitives'
import { Field, FieldContent, FieldDescription, FieldGroup, FieldLabel, FieldLegend, FieldSet } from '#components/ui/field'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '#components/ui/select'
import { Separator } from '#components/ui/separator'
import type { AuroraLocalSpeechCatalogPort } from './browser-speech-pack'
import { RouteStateNotice } from './state-surface'
import type { LocalSpeechAssetRow } from './voice-settings-local-speech-model'
import type { AuroraBackgroundTranscriptionPolicy } from '@aurora/client'
import {
  ROUTING_CHOICES,
  type NativeBackgroundTranscriptionStatus,
  type NativeSpeechPolicyState,
  type SpeechRoutingChoice,
} from './native-speech-policy'

export interface VoiceSettingsChoiceOption {
  id: string
  label: string
  detail?: string | undefined
  disabled?: boolean | undefined
}

export type VoiceSettingsLocalSpeechRow = LocalSpeechAssetRow

export interface VoiceSettingsWakePhraseOption {
  phraseId: string
  label: string
  detail: string
}

export interface LocalSpeechSettingsSectionProps {
  browserCatalogState: 'locked' | 'loading' | 'ready' | 'limited'
  actionPending: boolean
  speechLanguageValue: string
  speechLanguageOptions: readonly VoiceSettingsChoiceOption[]
  voiceLanguageValue: string
  voiceLanguageOptions: readonly VoiceSettingsChoiceOption[]
  listeningStartRows: readonly VoiceSettingsLocalSpeechRow[]
  wakeWordRows: readonly VoiceSettingsLocalSpeechRow[]
  transcriptionRows: readonly VoiceSettingsLocalSpeechRow[]
  spokenVoiceRows: readonly VoiceSettingsLocalSpeechRow[]
  listeningStartOptions: readonly VoiceSettingsChoiceOption[]
  wakeWordOptions: readonly VoiceSettingsChoiceOption[]
  transcriptionOptions: readonly VoiceSettingsChoiceOption[]
  spokenVoiceOptions: readonly VoiceSettingsChoiceOption[]
  defaultListeningStartKey: string | null
  defaultWakeWordsKey: string | null
  defaultTranscriptionKey: string | null
  defaultSpokenVoiceKey: string | null
  canConfigureBackgroundWake: boolean
  selectedWakePhraseId: string | null
  wakePhraseOptions: readonly VoiceSettingsWakePhraseOption[]
  canChooseWakePhrase: boolean
  selectedSpokenVoice: VoiceSettingsLocalSpeechRow | null
  referenceEditor: VoiceSettingsLocalSpeechRow | null
  pendingReferenceEditorKey: string | null
  localSpeechCatalog: AuroraLocalSpeechCatalogPort | null
  nativeSpeechPolicyState?: NativeSpeechPolicyState | undefined
  nativeSpeechPolicyMessage?: string | null | undefined
  nativeSttRoutingChoice?: SpeechRoutingChoice | undefined
  nativeTtsRoutingChoice?: SpeechRoutingChoice | undefined
  onNativeSpeechRoutingChange?: ((stage: 'stt' | 'tts', choice: SpeechRoutingChoice) => void) | undefined
  onSaveNativeSpeechRouting?: (() => void) | undefined
  speechSharing?: Readonly<Record<'stt' | 'tts' | 'kws' | 'vad', boolean>> | undefined
  remoteContinuousSpeech?: Readonly<{ kws: boolean; vad: boolean }> | undefined
  onSpeechSharingChange?: ((stage: 'stt' | 'tts' | 'kws' | 'vad', enabled: boolean) => void) | undefined
  onRemoteContinuousSpeechChange?: ((stage: 'kws' | 'vad', enabled: boolean) => void) | undefined
  backgroundTranscription: AuroraBackgroundTranscriptionPolicy
  backgroundTranscriptionStatus: NativeBackgroundTranscriptionStatus
  onBackgroundTranscriptionChange?: ((update: Partial<Pick<AuroraBackgroundTranscriptionPolicy, 'ambient' | 'notification' | 'retentionDays'>>) => void) | undefined
  onRequestTranscriptionMicrophonePermission?: (() => void) | undefined
  referenceFileInputRef: RefObject<HTMLInputElement | null>
  SearchableChoice: (props: {
    id: string
    value: string | null
    options: readonly VoiceSettingsChoiceOption[]
    placeholder: string
    searchPlaceholder: string
    emptyText: string
    ariaLabel: string
    disabled?: boolean | undefined
    onSelect: (id: string) => void
  }) => ReactNode
  onChoosePrimaryLanguage: (id: string) => void
  onChooseVoiceLanguage: (id: string) => void
  onSelectListeningStart: (id: string) => void
  onSelectWakeWords: (id: string) => void
  onSelectTranscription: (id: string) => void
  onSelectSpokenVoice: (id: string) => void
  onChooseWakePhrase: (id: string) => void
  onOpenReferenceEditor: (row: VoiceSettingsLocalSpeechRow) => void
  onDeleteReferenceVoiceSample: (row: VoiceSettingsLocalSpeechRow) => void
  onReferenceFileChange: (file: File | null) => void
  onSaveReferenceVoiceSample: () => void
  onCancelReferenceEditor: () => void
}

export function LocalSpeechSettingsSection({
  browserCatalogState,
  actionPending,
  speechLanguageValue,
  speechLanguageOptions,
  voiceLanguageValue,
  voiceLanguageOptions,
  listeningStartRows,
  wakeWordRows,
  transcriptionRows,
  spokenVoiceRows,
  listeningStartOptions,
  wakeWordOptions,
  transcriptionOptions,
  spokenVoiceOptions,
  defaultListeningStartKey,
  defaultWakeWordsKey,
  defaultTranscriptionKey,
  defaultSpokenVoiceKey,
  canConfigureBackgroundWake,
  selectedWakePhraseId,
  wakePhraseOptions,
  canChooseWakePhrase,
  selectedSpokenVoice,
  referenceEditor,
  pendingReferenceEditorKey,
  localSpeechCatalog,
  nativeSpeechPolicyState = 'hidden',
  nativeSpeechPolicyMessage = null,
  nativeSttRoutingChoice = 'local_first',
  nativeTtsRoutingChoice = 'local_first',
  onNativeSpeechRoutingChange,
  onSaveNativeSpeechRouting,
  speechSharing = { stt: false, tts: false, kws: false, vad: false },
  remoteContinuousSpeech = { kws: false, vad: false },
  onSpeechSharingChange,
  onRemoteContinuousSpeechChange,
  backgroundTranscription,
  backgroundTranscriptionStatus,
  onBackgroundTranscriptionChange,
  onRequestTranscriptionMicrophonePermission,
  referenceFileInputRef,
  SearchableChoice,
  onChoosePrimaryLanguage,
  onChooseVoiceLanguage,
  onSelectListeningStart,
  onSelectWakeWords,
  onSelectTranscription,
  onSelectSpokenVoice,
  onChooseWakePhrase,
  onOpenReferenceEditor,
  onDeleteReferenceVoiceSample,
  onReferenceFileChange,
  onSaveReferenceVoiceSample,
  onCancelReferenceEditor,
}: LocalSpeechSettingsSectionProps) {
  return (
    <Card title="Listening and speaking" description="Choose how Aurora listens, understands, and speaks.">
      <FieldGroup>
        {nativeSpeechPolicyState !== 'hidden' ? (
          <div className="grid gap-3 rounded-md border border-border p-3">
            <div>
              <h3 className="text-sm font-medium">Where speech is processed</h3>
              <p className="text-xs text-muted-foreground">Choose which device processes speech. These choices apply to your next conversation.</p>
            </div>
            {nativeSpeechPolicyState === 'loading' ? (
              <RouteStateNotice state="loading" title="Loading speech settings" message="Loading choices for this device." />
            ) : null}
            {nativeSpeechPolicyState === 'unavailable' ? (
              <RouteStateNotice state="error" title="Speech settings unavailable" message={nativeSpeechPolicyMessage ?? 'Speech settings could not be loaded on this device.'} />
            ) : null}
            {nativeSpeechPolicyState === 'ready' || nativeSpeechPolicyState === 'saving' ? (
              <>
                <Field>
                  <FieldLabel htmlFor="speech-stt-routing">Understanding speech</FieldLabel>
                  <select
                    id="speech-stt-routing"
                    className="h-9 rounded-md border border-input bg-background px-3 text-sm"
                    value={nativeSttRoutingChoice}
                    disabled={nativeSpeechPolicyState === 'saving'}
                    onChange={(event) => onNativeSpeechRoutingChange?.('stt', event.currentTarget.value as SpeechRoutingChoice)}
                  >
                    {ROUTING_CHOICES.map((choice) => <option key={choice.value} value={choice.value}>{choice.label}</option>)}
                  </select>
                  <FieldDescription>Choose where Aurora understands what you say.</FieldDescription>
                </Field>
                <Field>
                  <FieldLabel htmlFor="speech-tts-routing">Speaking aloud</FieldLabel>
                  <select
                    id="speech-tts-routing"
                    className="h-9 rounded-md border border-input bg-background px-3 text-sm"
                    value={nativeTtsRoutingChoice}
                    disabled={nativeSpeechPolicyState === 'saving'}
                    onChange={(event) => onNativeSpeechRoutingChange?.('tts', event.currentTarget.value as SpeechRoutingChoice)}
                  >
                    {ROUTING_CHOICES.map((choice) => <option key={choice.value} value={choice.value}>{choice.label}</option>)}
                  </select>
                  <FieldDescription>Choose where Aurora creates its speaking voice.</FieldDescription>
                </Field>
              </>
            ) : null}
            {nativeSpeechPolicyState === 'ready' || nativeSpeechPolicyState === 'saving' ? (
              <>
                <FieldSet className="gap-3">
                  <FieldLegend variant="label">Speech sharing</FieldLegend>
                  <FieldDescription>Choose which speech services connected devices may use on this device.</FieldDescription>
                  <FieldGroup className="gap-3">
                    {([
                      { stage: 'stt', label: 'Share speech recognition', detail: 'Let connected devices send speech here for recognition.' },
                      { stage: 'tts', label: 'Share spoken answers', detail: 'Let connected devices request spoken answers from this device.' },
                      { stage: 'kws', label: 'Share wake-word detection', detail: 'Let connected devices request wake-word detection on this device.' },
                      { stage: 'vad', label: 'Share speech detection', detail: 'Let connected devices request speech detection on this device.' },
                    ] as const).map(({ stage, label, detail }) => (
                      <Field key={stage} orientation="horizontal" data-disabled={nativeSpeechPolicyState === 'saving'}>
                        <FieldContent>
                          <FieldLabel htmlFor={`speech-sharing-${stage}`}>{label}</FieldLabel>
                          <FieldDescription>{detail}</FieldDescription>
                        </FieldContent>
                        <Switch
                          id={`speech-sharing-${stage}`}
                          label={label}
                          checked={speechSharing[stage]}
                          disabled={nativeSpeechPolicyState === 'saving'}
                          onChange={(enabled) => onSpeechSharingChange?.(stage, enabled)}
                        />
                      </Field>
                    ))}
                  </FieldGroup>
                </FieldSet>
                <Separator />
                <FieldSet className="gap-3">
                  <FieldLegend variant="label">Continuous detection</FieldLegend>
                  <FieldDescription>These separate choices allow connected devices to request continuous detection. They take effect only when the matching sharing choice above is also on.</FieldDescription>
                  <FieldGroup className="gap-3">
                    {([
                      { stage: 'kws', label: 'Allow connected wake-word requests', detail: 'Connected devices may send audio for wake-word detection on this device.' },
                      { stage: 'vad', label: 'Allow connected speech-detection requests', detail: 'Connected devices may send audio for speech detection on this device.' },
                    ] as const).map(({ stage, label, detail }) => (
                      <Field key={stage} orientation="horizontal" data-disabled={nativeSpeechPolicyState === 'saving'}>
                        <FieldContent>
                          <FieldLabel htmlFor={`speech-remote-${stage}`}>{label}</FieldLabel>
                          <FieldDescription>{detail}</FieldDescription>
                        </FieldContent>
                        <Switch
                          id={`speech-remote-${stage}`}
                          label={label}
                          checked={remoteContinuousSpeech[stage]}
                          disabled={nativeSpeechPolicyState === 'saving'}
                          onChange={(enabled) => onRemoteContinuousSpeechChange?.(stage, enabled)}
                        />
                      </Field>
                    ))}
                  </FieldGroup>
                </FieldSet>
              </>
            ) : null}
            {nativeSpeechPolicyState === 'ready' || nativeSpeechPolicyState === 'saving' ? (
              <div className="grid gap-3 border-t border-border pt-3">
                <div>
                  <h3 className="text-sm font-medium">Transcription while you’re away</h3>
                  <p className="text-xs text-muted-foreground">Transcripts are encrypted on this device. Microphone audio is not saved.</p>
                </div>
                <p className="text-xs text-muted-foreground">These choices apply when a new transcription session starts.</p>
                <FieldSet className="gap-2">
                  <FieldLegend variant="label">When Aurora can transcribe</FieldLegend>
                  <FieldGroup className="gap-2">
                    <Switch
                      id="background-transcription-ambient"
                      label="Continuous transcription"
                      checked={backgroundTranscription.ambient}
                      disabled={nativeSpeechPolicyState === 'saving' || (!backgroundTranscription.ambient && !canConfigureAmbientTranscription(backgroundTranscriptionStatus))}
                      disabledReason={transcriptionOptionDisabledReason(backgroundTranscriptionStatus, 'ambient')}
                      onChange={(ambient) => onBackgroundTranscriptionChange?.({ ambient })}
                    />
                    <Switch
                      id="background-transcription-notification"
                      label="Notification sessions"
                      checked={backgroundTranscription.notification}
                      disabled={nativeSpeechPolicyState === 'saving' || (!backgroundTranscription.notification && !canConfigureNotificationTranscription(backgroundTranscriptionStatus))}
                      disabledReason={transcriptionOptionDisabledReason(backgroundTranscriptionStatus, 'notification')}
                      onChange={(notification) => onBackgroundTranscriptionChange?.({ notification })}
                    />
                  </FieldGroup>
                </FieldSet>
                <Field>
                  <FieldLabel htmlFor="background-transcription-retention">Keep transcripts</FieldLabel>
                  <Select
                    value={String(backgroundTranscription.retentionDays)}
                    disabled={nativeSpeechPolicyState === 'saving'}
                    onValueChange={(value) => onBackgroundTranscriptionChange?.({ retentionDays: Number(value) })}
                  >
                    <SelectTrigger id="background-transcription-retention" className="w-full" disabled={nativeSpeechPolicyState === 'saving'}>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {retentionOptions(backgroundTranscription.retentionDays)
                        .map((days) => <SelectItem key={days} value={String(days)}>{retentionLabel(days)}</SelectItem>)}
                    </SelectContent>
                  </Select>
                  <FieldDescription>Older transcripts are removed automatically.</FieldDescription>
                </Field>
                <div className="grid gap-2">
                  <p role="status" className="text-xs text-muted-foreground">{transcriptionStatusLabel(backgroundTranscriptionStatus)}</p>
                  {backgroundTranscriptionStatus.facts
                    && backgroundTranscriptionStatus.facts.permission !== 'granted'
                    && backgroundTranscriptionStatus.availability === 'available' ? (
                      <Button
                        variant="outline"
                        className="h-8 w-fit px-3 text-xs"
                        disabled={nativeSpeechPolicyState === 'saving'}
                        onClick={() => void onRequestTranscriptionMicrophonePermission?.()}
                      >
                        Allow microphone access
                      </Button>
                    ) : null}
                </div>
                <div className="flex flex-wrap items-center gap-3">
                  <Button variant="outline" className="h-8 px-3 text-xs" onClick={() => void onSaveNativeSpeechRouting?.()} disabled={nativeSpeechPolicyState === 'saving'}>
                    {nativeSpeechPolicyState === 'saving' ? 'Saving…' : 'Save choices'}
                  </Button>
                  {nativeSpeechPolicyMessage && nativeSpeechPolicyState === 'ready' ? (
                    <p role="status" className="text-xs text-muted-foreground">{nativeSpeechPolicyMessage}</p>
                  ) : null}
                </div>
              </div>
            ) : null}
          </div>
        ) : null}
        {browserCatalogState === 'loading' ? (
          <RouteStateNotice state="loading" title="Loading speech choices" message="Loading listening and speaking choices." />
        ) : null}
        {browserCatalogState === 'limited' ? (
          <RouteStateNotice state="error" title="Speech choices unavailable" message="Speech downloads could not be loaded. Try again." />
        ) : null}
        <Field>
          <FieldLabel htmlFor="speech-primary-language">Primary language</FieldLabel>
          <SearchableChoice
            id="speech-primary-language"
            value={speechLanguageValue}
            options={speechLanguageOptions}
            placeholder="Choose a language"
            searchPlaceholder="Search languages"
            emptyText="No matching languages."
            ariaLabel="Choose primary language"
            disabled={actionPending}
            onSelect={onChoosePrimaryLanguage}
          />
          <FieldDescription>Used when Aurora needs one language.</FieldDescription>
        </Field>
        <Field>
          <FieldLabel htmlFor="speech-voice-language">Voice language</FieldLabel>
          <SearchableChoice
            id="speech-voice-language"
            value={voiceLanguageValue}
            options={voiceLanguageOptions}
            placeholder="Choose voice language"
            searchPlaceholder="Search voice languages"
            emptyText="No matching voice languages."
            ariaLabel="Choose voice language"
            disabled={actionPending}
            onSelect={onChooseVoiceLanguage}
          />
          <FieldDescription>Detect automatically, or keep listening and speaking in one language.</FieldDescription>
        </Field>
        {listeningStartRows.length > 0 ? (
          <Field>
            <FieldLabel htmlFor="speech-listening-start">Listening start</FieldLabel>
            <SearchableChoice
              id="speech-listening-start"
              value={defaultListeningStartKey}
              options={listeningStartOptions}
              placeholder="Choose listening start"
              searchPlaceholder="Search listening start"
              emptyText="No matching listening start choices."
              ariaLabel="Choose listening start"
              disabled={actionPending}
              onSelect={onSelectListeningStart}
            />
            <FieldDescription>Helps Aurora notice when speech begins.</FieldDescription>
          </Field>
        ) : null}
        {canConfigureBackgroundWake && wakeWordRows.length > 0 ? (
          <Field>
            <FieldLabel htmlFor="speech-wake-words">Wake words</FieldLabel>
            <SearchableChoice
              id="speech-wake-words"
              value={defaultWakeWordsKey}
              options={wakeWordOptions}
              placeholder="Choose wake words"
              searchPlaceholder="Search wake words"
              emptyText="No matching wake word choices."
              ariaLabel="Choose wake words"
              disabled={actionPending}
              onSelect={onSelectWakeWords}
            />
            <FieldDescription>Lets Aurora listen for its wake phrase.</FieldDescription>
          </Field>
        ) : null}
        {canConfigureBackgroundWake ? (
          <Field>
            <FieldLabel htmlFor="speech-wake-phrase">Wake phrase</FieldLabel>
            <SearchableChoice
              id="speech-wake-phrase"
              value={selectedWakePhraseId}
              options={wakePhraseOptions.map((option) => ({
                id: option.phraseId,
                label: option.label,
                detail: option.detail,
                disabled: !canChooseWakePhrase,
              }))}
              placeholder="Choose wake phrase"
              searchPlaceholder="Search wake phrases"
              emptyText="No matching wake phrases."
              ariaLabel="Choose wake phrase"
              disabled={actionPending || !canChooseWakePhrase}
              onSelect={onChooseWakePhrase}
            />
            <FieldDescription>
              {canChooseWakePhrase
                ? 'Choose the phrase Aurora listens for.'
                : 'Choose wake words before changing the phrase.'}
            </FieldDescription>
          </Field>
        ) : null}
        {transcriptionRows.length > 0 ? (
          <Field>
            <FieldLabel htmlFor="speech-transcription">Transcription</FieldLabel>
            <SearchableChoice
              id="speech-transcription"
              value={defaultTranscriptionKey}
              options={transcriptionOptions}
              placeholder="Choose transcription"
              searchPlaceholder="Search transcription"
              emptyText="No matching transcription choices."
              ariaLabel="Choose transcription"
              disabled={actionPending}
              onSelect={onSelectTranscription}
            />
            <FieldDescription>Turns your speech into text.</FieldDescription>
          </Field>
        ) : null}
        {spokenVoiceRows.length > 0 ? (
          <Field>
            <FieldLabel htmlFor="speech-spoken-voice">Spoken voice</FieldLabel>
            <SearchableChoice
              id="speech-spoken-voice"
              value={defaultSpokenVoiceKey}
              options={spokenVoiceOptions}
              placeholder="Choose spoken voice"
              searchPlaceholder="Search spoken voices"
              emptyText="No matching spoken voices."
              ariaLabel="Choose spoken voice"
              disabled={actionPending}
              onSelect={onSelectSpokenVoice}
            />
            <FieldDescription>Lets Aurora speak.</FieldDescription>
            {selectedSpokenVoice?.referenceProfileId ? (
              <div className="flex flex-wrap items-center gap-2">
                <Button
                  variant="outline"
                  className="h-8 px-3 text-xs"
                  onClick={() => onOpenReferenceEditor(selectedSpokenVoice)}
                  disabled={actionPending}
                >
                  Replace sample
                </Button>
                <Button
                  variant="outline"
                  className="h-8 px-3 text-xs"
                  onClick={() => onDeleteReferenceVoiceSample(selectedSpokenVoice)}
                  disabled={actionPending || !localSpeechCatalog?.deleteReferenceProfile}
                >
                  Remove sample
                </Button>
              </div>
            ) : null}
          </Field>
        ) : null}
        {referenceEditor ? (
          <form
            className="flex flex-col gap-3 rounded-md border border-current p-3"
            onSubmit={(event) => {
              event.preventDefault()
              onSaveReferenceVoiceSample()
            }}
          >
            <div>
              <p className="text-sm font-medium">{referenceEditor.label}</p>
              <p className="text-xs text-muted-foreground">Add a short WAV recording of the voice to clone.</p>
            </div>
            <label className="flex flex-col gap-1 text-sm">
              <span className="font-medium">Voice sample</span>
              <input
                ref={referenceFileInputRef}
                type="file"
                accept="audio/wav,audio/x-wav,.wav"
                onChange={(event) => onReferenceFileChange(event.currentTarget.files?.[0] ?? null)}
                disabled={actionPending}
              />
            </label>
            <div className="flex flex-wrap items-center gap-2">
              <Button
                type="button"
                variant="primary"
                className="h-8 px-3 text-xs"
                onClick={onSaveReferenceVoiceSample}
                disabled={actionPending || !localSpeechCatalog?.saveReferenceProfile}
              >
                {pendingReferenceEditorKey ? 'Saving' : 'Save sample'}
              </Button>
              <Button
                type="button"
                variant="outline"
                className="h-8 px-3 text-xs"
                onClick={onCancelReferenceEditor}
                disabled={actionPending}
              >
                Cancel
              </Button>
            </div>
          </form>
        ) : null}
      </FieldGroup>
    </Card>
  )
}

function retentionOptions(current: number): number[] {
  return [...new Set([7, 30, 90, 365, 3650, current])].sort((left, right) => left - right)
}

function retentionLabel(days: number): string {
  if (days === 365) return '1 year'
  if (days === 3650) return '10 years'
  return `${days} days`
}

function canConfigureAmbientTranscription(status: NativeBackgroundTranscriptionStatus): boolean {
  return status.availability === 'available' && status.facts?.capability === 'supported'
}

function canConfigureNotificationTranscription(status: NativeBackgroundTranscriptionStatus): boolean {
  return status.availability === 'available'
    && (status.facts?.capability === 'supported' || status.facts?.capability === 'foreground_only')
}

function transcriptionOptionDisabledReason(
  status: NativeBackgroundTranscriptionStatus,
  mode: 'ambient' | 'notification',
): string {
  if (status.availability === 'loading') return 'Waiting for this device.'
  if (status.availability === 'unavailable') return 'Transcription availability could not be confirmed.'
  if (status.availability === 'unsupported' || status.facts?.capability === 'unsupported') {
    return 'Background transcription is not available on this device.'
  }
  if (mode === 'ambient' && status.facts?.capability === 'foreground_only') {
    return 'Continuous transcription is not available on this device.'
  }
  return 'This choice is not available on this device.'
}

function transcriptionStatusLabel(status: NativeBackgroundTranscriptionStatus): string {
  if (status.availability === 'loading') return 'Checking transcription availability.'
  if (status.reason === 'notification_permission_missing') {
    return 'Allow Aurora notifications in device settings to start a recording from the notification.'
  }
  if (status.availability === 'unavailable') return status.message ?? 'Aurora could not confirm whether transcription is active.'
  if (status.availability === 'unsupported') return status.message ?? 'Transcription is not available on this device.'
  if (status.reason === 'unsupported' || status.facts?.capability === 'unsupported') {
    return 'Transcription is not available on this device.'
  }
  if (status.reason === 'permission_denied' || status.facts?.permission === 'denied') {
    return 'Microphone access is off in device settings.'
  }
  if (status.reason === 'permission_required' || status.facts?.permission === 'not_requested') {
    return 'Allow microphone access to use transcription.'
  }
  if (status.reason === 'speech_unavailable' || status.facts?.sttAvailable === false) {
    return 'Speech recognition is not ready on this device.'
  }
  if (status.reason === 'storage_unavailable' || status.facts?.archiveAvailable === false) {
    return 'Transcripts cannot be saved on this device right now.'
  }
  if (status.reason === 'foreground_required') {
    return 'Open Aurora before starting a notification session.'
  }
  if (status.reason === 'disabled') {
    return 'Not listening. Saved choices apply when a session starts.'
  }
  switch (status.captureState) {
    case 'starting': return 'Transcription is starting.'
    case 'listening': return 'Transcription is active.'
    case 'transcribing': return 'Transcription is being saved.'
    case 'completed': return 'The last transcription session finished.'
    case 'failed': return 'Transcription could not start.'
    case 'idle':
      return 'Not listening. Saved choices apply when a session starts.'
    default: return 'Aurora could not confirm whether transcription is active.'
  }
}
