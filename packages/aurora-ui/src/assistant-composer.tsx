'use client'

import type { FormEvent, KeyboardEvent, RefObject } from 'react'
import { ArrowUp, Cpu, Laptop, LoaderCircle, Mic, Network, Paperclip, Radio, RotateCcw, ShieldAlert, StopCircle } from 'lucide-react'
import { ModelSelector } from '#components/assistant-ui/model-selector'
import { cn } from '#lib/utils'
import { AudioRecorderVisualizer } from './audio-recorder-visualizer'
import { MobileConversationSheet } from './assistant-history'
import { ComposerAttachmentPreview } from './assistant-attachment-preview'
import { AssistantModelSourceSection } from './use-assistant-execution'
import { safeAssistantRuntimeValue } from './assistant-message'
import type {
  AssistantAttachmentDraft,
  AssistantConversationRow,
  AssistantExecutionOption,
  AssistantModelChoice,
  AssistantModelChoiceGroup,
  AssistantModelSourceGroup,
  AssistantVoiceModel,
  VoiceCaptureStatus,
  VoiceControlModel,
} from './assistant-view'
import type { RouteAvailability } from './shell-data'

export interface AssistantComposerProps {
  onSubmit: (event: FormEvent<HTMLFormElement>) => void
  voiceCaptureStatus: VoiceCaptureStatus
  mobileHistoryOpen: boolean
  onMobileHistoryOpenChange: (open: boolean) => void
  conversationRows: AssistantConversationRow[]
  conversationHasMore: boolean
  conversationPageLoading: boolean
  conversationPageError: string | null
  onLoadMoreConversations: () => void | Promise<void>
  sessionIndexLoading: boolean
  sessionIndexError: string | null
  conversationDisabled: boolean
  newConversationDisabled: boolean
  onSelectConversation: (sessionId: string) => void
  onNewConversation: () => void
  executionOptions: AssistantExecutionOption[]
  selectedExecution: AssistantExecutionOption
  onExecutionOptionChange: (value: string) => void
  modelChoices: AssistantModelChoice[]
  selectedModelChoice: AssistantModelChoice
  onModelChoiceChange: (value: string) => void
  modelCatalogError: string | null
  modelCatalogLoading: boolean
  modelSearchQuery: string
  onModelSearchQueryChange: (value: string) => void
  modelChoiceGroups: AssistantModelChoiceGroup[]
  modelSourceGroups: AssistantModelSourceGroup[]
  attachments: AssistantAttachmentDraft[]
  contextSummary: { ready: number; blocked: number }
  attachmentInputRef: RefObject<HTMLInputElement | null>
  attachmentPickerAccept: string
  canAttach: boolean
  onFileInput: (files: FileList | null) => void | Promise<void>
  onRemoveAttachment: (id: string) => void
  onOpenAttachmentPicker: () => void | Promise<void>
  connectedVoiceAccessGranted: boolean
  remoteAudioConsentPending: boolean
  onToggleRemoteAudioConsent: () => void | Promise<void>
  textAreaRef: RefObject<HTMLTextAreaElement | null>
  text: string
  onTextChange: (value: string) => void
  onComposerKeyDown: (event: KeyboardEvent<HTMLTextAreaElement>) => void
  canSend: boolean
  routeDisabled: boolean
  voiceModel: AssistantVoiceModel
  voiceElapsedSeconds: number
  nativeMobileBackgroundOwnsMicrophone: boolean
  onRequestVoiceToggle: () => void
  voiceCaptureButtonLabel: string
  usesNativeDesktopVoice: boolean
  handsFreeControl: VoiceControlModel | undefined
  handsFreeActive: boolean
  onToggleNativeDesktopBackgroundWake: () => void | Promise<boolean>
  primaryComposerAction: 'send' | 'stop' | 'retry'
  primaryComposerDisabled: boolean
  primaryComposerAriaLabel: string
  primaryComposerLabel: string
  onPrimaryComposerAction: () => void | Promise<void>
  lastError: string | null
}

export function AssistantComposer({
  onSubmit,
  voiceCaptureStatus,
  mobileHistoryOpen,
  onMobileHistoryOpenChange,
  conversationRows,
  conversationHasMore,
  conversationPageLoading,
  conversationPageError,
  onLoadMoreConversations,
  sessionIndexLoading,
  sessionIndexError,
  conversationDisabled,
  newConversationDisabled,
  onSelectConversation,
  onNewConversation,
  executionOptions,
  selectedExecution,
  onExecutionOptionChange,
  modelChoices,
  selectedModelChoice,
  onModelChoiceChange,
  modelCatalogError,
  modelCatalogLoading,
  modelSearchQuery,
  onModelSearchQueryChange,
  modelChoiceGroups,
  modelSourceGroups,
  attachments,
  contextSummary,
  attachmentInputRef,
  attachmentPickerAccept,
  canAttach,
  onFileInput,
  onRemoveAttachment,
  onOpenAttachmentPicker,
  connectedVoiceAccessGranted,
  remoteAudioConsentPending,
  onToggleRemoteAudioConsent,
  textAreaRef,
  text,
  onTextChange,
  onComposerKeyDown,
  canSend,
  routeDisabled,
  voiceModel,
  voiceElapsedSeconds,
  nativeMobileBackgroundOwnsMicrophone,
  onRequestVoiceToggle,
  voiceCaptureButtonLabel,
  usesNativeDesktopVoice,
  handsFreeControl,
  handsFreeActive,
  onToggleNativeDesktopBackgroundWake,
  primaryComposerAction,
  primaryComposerDisabled,
  primaryComposerAriaLabel,
  primaryComposerLabel,
  onPrimaryComposerAction,
  lastError,
}: AssistantComposerProps) {
  const showHandsFreeControl = Boolean(usesNativeDesktopVoice && handsFreeControl && (handsFreeControl.enabled || handsFreeActive))

  return (
    <form
      data-aurora-part="assistant-composer"
      className="[--aui-chat-width:42rem] flex w-full flex-none flex-col items-stretch gap-2 border-0 bg-[linear-gradient(180deg,transparent,color-mix(in_srgb,var(--aui-bg)_94%,transparent)_28%)] px-[max(1rem,clamp(1rem,1.8vw,1.6rem))] pb-[0.9rem] pt-[0.65rem] [@media(max-width:1040px)]:relative [@media(max-width:1040px)]:bottom-auto [@media(max-width:1040px)]:mt-auto [@media(max-width:720px)]:z-[1] [@media(max-width:720px)]:box-border [@media(max-width:720px)]:w-full [@media(max-width:720px)]:min-w-0 [@media(max-width:720px)]:max-w-full [@media(max-width:720px)]:isolate [@media(max-width:720px)]:p-0 [@media(max-width:720px)]:pt-[0.45rem] [@media(max-width:720px)]:transform-none"
      onSubmit={onSubmit}
      aria-label="Prompt composer"
      data-voice-active={voiceCaptureStatus === 'listening' ? 'true' : undefined}
    >
      <div data-aurora-part="assistant-composer-toolbar" className="[--aui-chat-width:42rem] flex min-h-[2.45rem] w-full max-w-none items-start justify-between gap-3 relative col-span-full flex-wrap p-0 text-[0.75rem] font-medium text-[var(--aui-muted)] [@media(max-width:720px)]:box-border [@media(max-width:720px)]:items-center [@media(max-width:720px)]:gap-[0.35rem] [@media(max-width:720px)]:overflow-visible [@media(max-width:720px)]:px-3 [@media(max-width:720px)]:text-[0.72rem]" aria-label="Route/model selector">
        <MobileConversationSheet
          open={mobileHistoryOpen}
          onOpenChange={onMobileHistoryOpenChange}
          rows={conversationRows}
          loading={sessionIndexLoading}
          error={sessionIndexError}
          hasMore={conversationHasMore}
          pageLoading={conversationPageLoading}
          pageError={conversationPageError}
          disabled={conversationDisabled}
          newConversationDisabled={newConversationDisabled}
          onSelectConversation={onSelectConversation}
          onNewConversation={onNewConversation}
          onLoadMore={() => void onLoadMoreConversations()}
        />
        <div className="flex min-w-0 flex-auto items-center gap-1 overflow-hidden [@media(max-width:720px)]:max-w-none [@media(max-width:720px)]:gap-[0.35rem] [@media(max-width:720px)]:overflow-visible">
          <ModelSelector.Root
            models={executionOptions.map((option) => {
              const optionLabel = safeAssistantRuntimeValue(option.label, 'Connected Aurora device') ?? 'Connected Aurora device'
              return {
                id: option.id,
                name: option.mode === 'local' ? 'This device' : optionLabel,
                description: option.description,
                icon: option.mode === 'local' ? <Laptop aria-hidden /> : <Network aria-hidden />
              }
            })}
            value={selectedExecution.id}
            onValueChange={(value) => {
              if (value === selectedExecution.id) return
              onExecutionOptionChange(value)
            }}
          >
            <ModelSelector.Trigger
              variant="ghost"
              size="sm"
              className=" inline-flex min-h-[2.15rem] min-w-0 max-w-[min(23rem,44vw)] shrink items-center gap-[0.45rem] rounded-full border border-[color-mix(in_srgb,var(--aui-border)_85%,transparent)] bg-[color-mix(in_srgb,var(--aui-surface-2)_74%,var(--aui-bg))] px-[0.65rem] py-[0.2rem] !font-[750] justify-center !text-[0.74rem] text-[var(--aui-ink)] transition-[color,border-color,background-color,transform] duration-[140ms] hover:border-[color-mix(in_srgb,var(--aui-primary)_32%,var(--aui-border))] hover:bg-[color-mix(in_srgb,var(--aui-surface-2)_92%,var(--aui-bg))] hover:text-[var(--aui-ink)] focus-visible:outline-2 focus-visible:outline-offset-[-1px] focus-visible:outline-[color-mix(in_srgb,var(--aui-primary)_72%,transparent)] [@media(max-width:720px)]:w-auto [@media(max-width:720px)]:min-w-[5.5rem] [@media(max-width:720px)]:max-w-[44%] [@media(max-width:720px)]:flex-[0_1_9rem] [@media(max-width:720px)]:overflow-hidden [@media(max-width:720px)]:px-[0.45rem]"
              aria-label={`Using ${selectedExecution.mode === 'local' ? 'this device' : safeAssistantRuntimeValue(selectedExecution.label, 'Connected Aurora device') ?? 'Connected Aurora device'}`}
            >
              {selectedExecution.mode === 'local' ? <Laptop aria-hidden /> : <Network aria-hidden />}
              <span className="text-[0.68rem] tracking-[0.01em] text-[var(--aui-muted)] uppercase [@media(max-width:720px)]:hidden">Using</span>
              <strong className="[@media(max-width:720px)]:min-w-0 [@media(max-width:720px)]:overflow-hidden [@media(max-width:720px)]:text-ellipsis [@media(max-width:720px)]:whitespace-nowrap">{selectedExecution.mode === 'local' ? 'this device' : safeAssistantRuntimeValue(selectedExecution.label, 'Connected Aurora device') ?? 'Connected Aurora device'}</strong>
            </ModelSelector.Trigger>
            <ModelSelector.Content side="top" searchable={false} className="aui-execution-selector-content max-h-[44vh] w-[min(30rem,min(96vw,var(--aui-chat-width,30rem)))] max-w-[30rem] origin-top-right overflow-hidden border-[color-mix(in_srgb,var(--aui-border)_82%,transparent)] bg-[color-mix(in_srgb,var(--aui-surface)_96%,transparent)] text-[var(--aui-ink)] opacity-100 animate-[aui-composer-menu-open_140ms_cubic-bezier(0.2,0.8,0.2,1)_forwards] data-closed:translate-y-[-2px] data-closed:scale-y-[0.96] data-closed:opacity-0 data-open:translate-y-0 data-open:scale-y-100 data-open:opacity-100">
              <ModelSelector.List>
                <ModelSelector.Group heading="Device">
                  {executionOptions.map((option) => {
                    const optionLabel = safeAssistantRuntimeValue(option.label, 'Connected Aurora device') ?? 'Connected Aurora device'
                    const model = {
                      id: option.id,
                      name: option.mode === 'local' ? 'This device' : optionLabel,
                      description: option.description,
                      icon: option.mode === 'local' ? <Laptop aria-hidden /> : <Network aria-hidden />
                    }
                    return <ModelSelector.Item key={option.id} model={model} />
                  })}
                </ModelSelector.Group>
              </ModelSelector.List>
            </ModelSelector.Content>
          </ModelSelector.Root>

          <ModelSelector.Root
            models={modelChoices.map((choice) => choice.model)}
            value={selectedModelChoice.id}
            onValueChange={onModelChoiceChange}
          >
            <ModelSelector.Trigger
              variant="ghost"
              size="sm"
              className=" inline-flex min-h-[2.15rem] min-w-0 max-w-[min(23rem,44vw)] shrink items-center gap-[0.45rem] rounded-full border border-[color-mix(in_srgb,var(--aui-border)_85%,transparent)] bg-[color-mix(in_srgb,var(--aui-surface-2)_74%,var(--aui-bg))] px-[0.65rem] py-[0.2rem] !font-[750] justify-center !text-[0.74rem] text-[var(--aui-ink)] transition-[color,border-color,background-color,transform] duration-[140ms] hover:border-[color-mix(in_srgb,var(--aui-primary)_32%,var(--aui-border))] hover:bg-[color-mix(in_srgb,var(--aui-surface-2)_92%,var(--aui-bg))] hover:text-[var(--aui-ink)] focus-visible:outline-2 focus-visible:outline-offset-[-1px] focus-visible:outline-[color-mix(in_srgb,var(--aui-primary)_72%,transparent)] [@media(max-width:720px)]:w-auto [@media(max-width:720px)]:min-w-[5.5rem] [@media(max-width:720px)]:max-w-none [@media(max-width:720px)]:flex-[1_1_7rem] [@media(max-width:720px)]:overflow-hidden [@media(max-width:720px)]:px-[0.45rem] [@media(max-width:720px)]:[&_[data-slot=model-selector-value]]:min-w-0 [@media(max-width:720px)]:[&_[data-slot=model-selector-value]]:overflow-hidden [@media(max-width:720px)]:[&_[data-slot=model-selector-value]]:text-ellipsis [@media(max-width:720px)]:[&_[data-slot=model-selector-value]]:whitespace-nowrap [@media(max-width:720px)]:[&_[data-slot=model-selector-value]>*]:min-w-0 [@media(max-width:720px)]:[&_[data-slot=model-selector-value]>*]:overflow-hidden [@media(max-width:720px)]:[&_[data-slot=model-selector-value]>*]:text-ellipsis [@media(max-width:720px)]:[&_[data-slot=model-selector-value]>*]:whitespace-nowrap [&_[data-slot=model-selector-icon]]:hidden"
              aria-label={`Model: ${selectedModelChoice.model.name}`}
              title={modelCatalogError ?? undefined}
            >
              <Cpu aria-hidden />
              <span className="text-[0.68rem] tracking-[0.01em] text-[var(--aui-muted)] uppercase [@media(max-width:720px)]:hidden">Model</span>
              <ModelSelector.Value showEffort={false} />
              {modelCatalogLoading ? <LoaderCircle aria-label="Loading models" /> : null}
            </ModelSelector.Trigger>
            <ModelSelector.Content side="top" searchable className="aui-assistant-model-selector-content max-h-[44vh] w-[min(30rem,min(96vw,var(--aui-chat-width,30rem)))] max-w-[30rem] origin-top-right overflow-hidden border-[color-mix(in_srgb,var(--aui-border)_82%,transparent)] bg-[color-mix(in_srgb,var(--aui-surface)_96%,transparent)] text-[var(--aui-ink)] opacity-100 animate-[aui-composer-menu-open_140ms_cubic-bezier(0.2,0.8,0.2,1)_forwards] data-closed:translate-y-[-2px] data-closed:scale-y-[0.96] data-closed:opacity-0 data-open:translate-y-0 data-open:scale-y-100 data-open:opacity-100">
              <ModelSelector.Search
                placeholder="Search available models..."
                value={modelSearchQuery}
                onValueChange={onModelSearchQueryChange}
              />
              <ModelSelector.List>
                <ModelSelector.Empty>{modelCatalogLoading ? 'Loading available models…' : 'No available models.'}</ModelSelector.Empty>
                {modelChoiceGroups.filter((group) => group.scope === 'default').map((group) => (
                  <ModelSelector.Group key={group.id} heading={group.heading}>
                    {group.choices.map((choice) => <ModelSelector.Item key={choice.id} model={choice.model} />)}
                  </ModelSelector.Group>
                ))}
                {modelSourceGroups.map((source) => (
                  <AssistantModelSourceSection
                    key={source.id}
                    source={source}
                    query={modelSearchQuery}
                  />
                ))}
              </ModelSelector.List>
            </ModelSelector.Content>
          </ModelSelector.Root>
        </div>
        {attachments.length > 0 ? (
          <div className="flex min-w-0 flex-none items-center gap-1 ml-auto [@media(max-width:720px)]:gap-0">
            <span>{attachments.length} attached</span>
          </div>
        ) : null}
      </div>
      <label htmlFor="assistant-prompt" className="sr-only">Prompt</label>
      {voiceCaptureStatus === 'listening' ? (
        <div data-aurora-part="assistant-composer-recorder" className="w-full max-w-[var(--aui-chat-width)] mx-auto min-w-0 animate-[aui-composer-recorder-in_0.16s_ease-out] [@media(max-width:720px)]:mx-3 [@media(max-width:720px)]:w-auto [@media(max-width:720px)]:max-w-none">
          <AudioRecorderVisualizer
            status={voiceCaptureStatus}
            bars={voiceModel.waveformBars}
            elapsedSeconds={voiceElapsedSeconds}
            showControls={false}
            variant="composer"
            className="min-h-9 w-full"
            title="Listening"
            sourceLabel="This device microphone"
            detail="Live microphone level"
          />
        </div>
      ) : null}
      <input
        id="assistant-context-file-input"
        ref={attachmentInputRef}
        className="sr-only"
        type="file"
        aria-label="Attach context files"
        multiple
        accept={attachmentPickerAccept}
        disabled={!canAttach}
        onChange={(event) => {
          void onFileInput(event.currentTarget.files)
          event.currentTarget.value = ''
        }}
      />
      <section className="sr-only" aria-labelledby="assistant-context-title">
        <h2 id="assistant-context-title">Attachment context status</h2>
        <p>{contextSummary.ready} ready, {contextSummary.blocked} blocked</p>
      </section>
      {attachments.length > 0 ? (
        <ComposerAttachmentPreview attachments={attachments} onRemove={onRemoveAttachment} />
      ) : null}
      <div
        data-aurora-part="assistant-composer-control-row"
        data-aurora-hands-free={showHandsFreeControl ? 'available' : undefined}
        className={cn(
          'grid min-h-[3.4rem] items-center overflow-hidden rounded-[1rem] border border-[color-mix(in_srgb,var(--aui-border)_82%,transparent)] bg-[color-mix(in_srgb,var(--aui-surface-2)_82%,var(--aui-bg))] p-[0.3rem] shadow-[0_0.75rem_2rem_rgb(0_0_0_/_0.16),inset_0_1px_0_rgb(255_255_255_/_0.025)] backdrop-blur-[8px] transition-[border-color,box-shadow,background] duration-150 focus-within:border-[color-mix(in_srgb,var(--aui-primary)_46%,var(--aui-border))] focus-within:bg-[color-mix(in_srgb,var(--aui-surface-2)_92%,var(--aui-bg))] focus-within:shadow-[0_0_0_3px_color-mix(in_srgb,var(--aui-primary)_9%,transparent),0_0.85rem_2.2rem_rgb(0_0_0_/_0.2)] [@media(max-width:720px)]:relative [@media(max-width:720px)]:z-[1] [@media(max-width:720px)]:w-full [@media(max-width:720px)]:max-w-full [@media(max-width:720px)]:min-w-0 [@media(max-width:720px)]:rounded-t-[1rem] [@media(max-width:720px)]:rounded-b-none [@media(max-width:720px)]:p-1',
          showHandsFreeControl
            ? 'grid-cols-[2.65rem_2.65rem_minmax(0,1fr)_2.65rem_2.65rem_2.65rem] [@media(max-width:720px)]:grid-cols-[2.5rem_2.5rem_minmax(0,1fr)_2.5rem_2.5rem_2.5rem]'
            : 'grid-cols-[2.65rem_2.65rem_minmax(0,1fr)_2.65rem_2.65rem] [@media(max-width:720px)]:grid-cols-[2.5rem_2.5rem_minmax(0,1fr)_2.5rem_2.5rem]'
        )}
      >
        <button
          type="button"
          data-aurora-part="assistant-composer-attach"
          data-aurora-control="button"
          className="col-start-1 row-start-1 grid size-[2.65rem] min-h-[2.65rem] place-items-center rounded-[0.72rem] border-0 bg-transparent p-0 text-[var(--aui-muted)] transition-[background-color,color,transform] duration-[140ms] hover:bg-white/[0.055] hover:text-[var(--aui-ink)] focus-visible:outline-2 focus-visible:outline-offset-[-1px] focus-visible:outline-[color-mix(in_srgb,var(--aui-primary)_72%,transparent)] [@media(max-width:720px)]:relative [@media(max-width:720px)]:z-[2] [@media(max-width:720px)]:size-10 [@media(max-width:720px)]:min-h-10"
          disabled={!canAttach}
          aria-label="Attach context"
          onClick={() => void onOpenAttachmentPicker()}
        >
          <Paperclip size={18} aria-hidden />
        </button>
        <button
          type="button"
          data-aurora-part="assistant-composer-voice-access"
          data-aurora-control="button"
          className="col-start-2 row-start-1 grid size-[2.65rem] min-h-[2.65rem] place-items-center rounded-[0.72rem] border-0 bg-transparent p-0 text-[var(--aui-muted)] transition-[background-color,color,transform] duration-[140ms] hover:bg-white/[0.055] hover:text-[var(--aui-ink)] focus-visible:outline-2 focus-visible:outline-offset-[-1px] focus-visible:outline-[color-mix(in_srgb,var(--aui-primary)_72%,transparent)] [@media(max-width:720px)]:relative [@media(max-width:720px)]:z-[2] [@media(max-width:720px)]:size-10 [@media(max-width:720px)]:min-h-10"
          data-voice-access={connectedVoiceAccessGranted ? 'granted' : 'required'}
          aria-label={connectedVoiceAccessGranted ? 'Stop connected voice access' : 'Allow connected voice'}
          title={connectedVoiceAccessGranted ? 'Stop connected voice access' : 'Allow connected voice'}
          disabled={remoteAudioConsentPending}
          onClick={(event) => { event.preventDefault(); void onToggleRemoteAudioConsent() }}
        >
          <ShieldAlert size={18} aria-hidden />
          <span className="sr-only">{connectedVoiceAccessGranted ? 'Stop connected voice access' : 'Allow connected voice'}</span>
        </button>
        <div data-aurora-part="assistant-composer-input" className="col-start-3 row-start-1 flex min-h-[2.65rem] min-w-0 items-center rounded-none border-0 bg-transparent px-[0.35rem]" data-voice-active={voiceCaptureStatus === 'listening' ? 'true' : undefined}>
          <textarea
            id="assistant-prompt"
            ref={textAreaRef}
            value={text}
            onChange={(event) => onTextChange(event.currentTarget.value)}
            onKeyDown={onComposerKeyDown}
            disabled={!canSend && voiceCaptureStatus !== 'listening'}
            readOnly={voiceCaptureStatus === 'listening'}
            className="relative z-[2] h-auto max-h-40 min-h-[2.65rem] w-full resize-none rounded-none border-0 bg-transparent px-[0.15rem] py-[0.68rem] !text-[0.9rem] !leading-[1.4] text-[var(--aui-ink)] focus:outline-none [@media(max-width:720px)]:min-h-10"
            placeholder={routeDisabled ? 'Assistant capability is unavailable' : voiceCaptureStatus === 'listening' ? 'Realtime transcription appears here…' : 'Ask Aurora...'}
            rows={voiceCaptureStatus === 'listening' ? 2 : 1}
          />
        </div>
        <button
          type="button"
          className={cn(
            'col-start-4 row-start-1 grid size-[2.65rem] min-h-[2.65rem] place-items-center rounded-[0.72rem] border-0 bg-transparent p-0 text-[var(--aui-muted)] transition-[background-color,color,transform] duration-[140ms] hover:bg-white/[0.055] hover:text-[var(--aui-ink)] focus-visible:outline-2 focus-visible:outline-offset-[-1px] focus-visible:outline-[color-mix(in_srgb,var(--aui-primary)_72%,transparent)] [@media(max-width:720px)]:relative [@media(max-width:720px)]:z-[2] [@media(max-width:720px)]:size-10 [@media(max-width:720px)]:min-h-10',
            voiceCaptureStatus === 'listening' && 'bg-[color-mix(in_srgb,var(--aui-primary)_18%,transparent)] text-[var(--aui-primary)]'
          )}
          data-aurora-part="assistant-composer-push-to-talk"
          data-aurora-control="button"
          data-voice-state={nativeMobileBackgroundOwnsMicrophone ? 'background' : voiceCaptureStatus === 'listening' ? 'listening' : 'idle'}
          disabled={voiceCaptureStatus === 'processing'}
          onClick={(event) => { event.preventDefault(); onRequestVoiceToggle() }}
          aria-label={voiceCaptureButtonLabel}
          title={voiceCaptureButtonLabel}
        >
          {voiceCaptureStatus === 'listening' ? <StopCircle size={18} aria-hidden /> : <Mic size={18} aria-hidden />}
          <span className="sr-only">{voiceCaptureButtonLabel}</span>
        </button>
        {showHandsFreeControl && handsFreeControl ? (
          <button
            type="button"
            data-aurora-part="assistant-composer-hands-free"
            data-aurora-control="button"
            className="col-start-5 row-start-1 grid size-[2.65rem] min-h-[2.65rem] place-items-center rounded-[0.72rem] border-0 bg-transparent p-0 text-[var(--aui-muted)] transition-[background-color,color,transform] duration-[140ms] hover:bg-white/[0.055] hover:text-[var(--aui-ink)] focus-visible:outline-2 focus-visible:outline-offset-[-1px] focus-visible:outline-[color-mix(in_srgb,var(--aui-primary)_72%,transparent)] [@media(max-width:720px)]:relative [@media(max-width:720px)]:z-[2] [@media(max-width:720px)]:size-10 [@media(max-width:720px)]:min-h-10"
            data-hands-free={handsFreeActive ? 'active' : 'idle'}
            disabled={!handsFreeControl.enabled && !handsFreeActive}
            aria-pressed={handsFreeActive}
            aria-label={handsFreeControl.label}
            title={handsFreeControl.reason}
            onClick={(event) => { event.preventDefault(); void onToggleNativeDesktopBackgroundWake() }}
          >
            <Radio size={18} aria-hidden />
            <span className="sr-only">{handsFreeControl.label}</span>
          </button>
        ) : null}
        <button
          type={primaryComposerAction === 'send' ? 'submit' : 'button'}
          data-aurora-part="assistant-composer-send"
          data-aurora-control="button"
          className={cn(
            'row-start-1 grid size-[2.65rem] min-h-[2.65rem] place-items-center rounded-[0.72rem] border-0 bg-[var(--aui-primary)] p-0 text-[var(--aui-primary-foreground)] shadow-[0_0.35rem_0.9rem_color-mix(in_srgb,var(--aui-primary)_18%,transparent)] transition-[background-color,color,transform] duration-[140ms] disabled:opacity-[0.58] disabled:cursor-not-allowed enabled:hover:bg-[color-mix(in_srgb,var(--aui-primary)_88%,white)] enabled:active:scale-[0.98] focus-visible:outline-2 focus-visible:outline-offset-[-1px] focus-visible:outline-[color-mix(in_srgb,var(--aui-primary)_72%,transparent)] [@media(max-width:720px)]:relative [@media(max-width:720px)]:z-[2] [@media(max-width:720px)]:size-10 [@media(max-width:720px)]:min-h-10',
            showHandsFreeControl ? 'col-start-6' : 'col-start-5'
          )}
          data-composer-action={primaryComposerAction}
          disabled={primaryComposerDisabled}
          aria-label={primaryComposerAriaLabel}
          onClick={primaryComposerAction === 'send' ? undefined : () => void onPrimaryComposerAction()}
        >
          {primaryComposerAction === 'retry' ? <RotateCcw size={17} aria-hidden /> : primaryComposerAction === 'stop' ? <StopCircle size={17} aria-hidden /> : <ArrowUp size={17} aria-hidden />}
          <span className="hidden">{primaryComposerLabel}</span>
        </button>
      </div>
      {lastError ? (
        <p data-aurora-part="assistant-composer-voice-recovery" className="mx-auto mt-[0.45rem] w-full max-w-[var(--aui-chat-width)] text-[0.78rem] leading-[1.4] text-[var(--aui-danger,#ef4444)] [@media(max-width:720px)]:mx-3 [@media(max-width:720px)]:w-auto [@media(max-width:720px)]:max-w-none" data-voice-recovery="true" role="alert">{lastError}</p>
      ) : null}
    </form>
  )
}
