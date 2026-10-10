import type { ReactNode, RefObject } from 'react'
import { Button, Card } from './primitives'
import { Field, FieldDescription, FieldGroup, FieldLabel } from '#components/ui/field'
import type { AuroraLocalSpeechCatalogPort } from './browser-speech-pack'
import { RouteStateNotice } from './state-surface'
import type { LocalSpeechAssetRow } from './voice-settings-local-speech-model'

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
