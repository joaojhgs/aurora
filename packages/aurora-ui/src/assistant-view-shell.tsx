'use client'

import { Profiler, useCallback, useEffect, useMemo, useRef, type FormEvent, type KeyboardEvent, type RefObject } from 'react'
import { RotateCcw, WifiOff } from 'lucide-react'
import { Marker, MarkerContent } from '#components/ui/marker'
import {
  MessageScroller,
  MessageScrollerButton,
  MessageScrollerContent,
  MessageScrollerItem,
  MessageScrollerProvider,
  MessageScrollerViewport,
} from '#components/ui/message-scroller'
import { ConversationRail } from './assistant-history'
import { AssistantComposer } from './assistant-composer'
import { AssistantRuntimeStrip } from './assistant-status'
import { ChatBubble } from './assistant-message'
import { createAuroraReactProfilerOnRender } from './react-profiler'
import type {
  AssistantAttachmentDraft,
  AssistantApprovalGrantScope,
  AssistantRuntimeHealth,
  AssistantConversationRow,
  AssistantExecutionOption,
  AssistantModelChoice,
  AssistantModelChoiceGroup,
  AssistantModelSourceGroup,
  AssistantStreamState,
  AssistantToolCallCard,
  AssistantUiMessage,
  AssistantVoiceModel,
  VoiceCaptureStatus,
  VoiceControlModel,
} from './assistant-view'

const assistantThreadProfilerOnRender = createAuroraReactProfilerOnRender('assistant.thread')
const assistantComposerProfilerOnRender = createAuroraReactProfilerOnRender('assistant.composer')

interface AssistantOlderMessagesControlProps {
  readonly viewportRef: RefObject<HTMLDivElement | null>
  readonly conversationId: string | null
  readonly streamScopeId: string
  readonly hasMore: boolean
  readonly loading: boolean
  readonly error: string | null
  readonly onLoad: () => void | Promise<void>
  readonly historyScopeKey: string
}

export function AssistantOlderMessagesControl({ viewportRef, conversationId, streamScopeId, historyScopeKey, hasMore, loading, error, onLoad }: AssistantOlderMessagesControlProps) {
  const anchorRef = useRef<{ id: string; top: number } | null>(null)
  const observerRef = useRef<ResizeObserver | null>(null)
  const frameRef = useRef<number | null>(null)

  const cancelAnchor = useCallback(() => {
    anchorRef.current = null
    observerRef.current?.disconnect()
    observerRef.current = null
    if (frameRef.current !== null) window.cancelAnimationFrame(frameRef.current)
    frameRef.current = null
  }, [])

  useEffect(() => cancelAnchor(), [cancelAnchor, conversationId, historyScopeKey, streamScopeId])

  useEffect(() => {
    const viewport = viewportRef.current
    if (!viewport) return
    const release = () => cancelAnchor()
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (['ArrowDown', 'ArrowUp', 'PageDown', 'PageUp', 'Home', 'End', ' '].includes(event.key)) release()
    }
    viewport.addEventListener('wheel', release, { passive: true })
    viewport.addEventListener('touchstart', release, { passive: true })
    viewport.addEventListener('pointerdown', release, { passive: true })
    viewport.addEventListener('keydown', onKeyDown)
    const endButton = viewport.parentElement?.querySelector<HTMLElement>('[data-slot="message-scroller-button"][data-direction="end"]')
    endButton?.addEventListener('click', release)
    return () => {
      viewport.removeEventListener('wheel', release)
      viewport.removeEventListener('touchstart', release)
      viewport.removeEventListener('pointerdown', release)
      viewport.removeEventListener('keydown', onKeyDown)
      endButton?.removeEventListener('click', release)
    }
  }, [cancelAnchor, viewportRef])

  const restoreAnchor = useCallback(() => {
    const anchor = anchorRef.current
    const viewport = viewportRef.current
    if (!anchor || !viewport) return
    const item = Array.from(viewport.querySelectorAll<HTMLElement>('[data-message-id]')).find((candidate) => candidate.dataset.messageId === anchor.id)
    if (!item) return
    const delta = item.getBoundingClientRect().top - viewport.getBoundingClientRect().top - anchor.top
    if (Math.abs(delta) > 0.5) {
      viewport.scrollTop += delta
    }
  }, [viewportRef])

  const observeAnchor = useCallback(() => {
    const viewport = viewportRef.current
    const content = viewport?.querySelector<HTMLElement>('[data-slot="message-scroller-content"]')
    if (!viewport || !content || typeof ResizeObserver === 'undefined') return
    observerRef.current?.disconnect()
    observerRef.current = new ResizeObserver(() => {
      if (frameRef.current !== null) return
      frameRef.current = window.requestAnimationFrame(() => {
        frameRef.current = null
        restoreAnchor()
      })
    })
    observerRef.current.observe(content)
    observerRef.current.observe(viewport)
  }, [restoreAnchor, viewportRef])

  const handleLoad = async () => {
    if (loading) return
    cancelAnchor()
    const viewport = viewportRef.current
    const viewportTop = viewport?.getBoundingClientRect().top ?? 0
    const visible = viewport
      ? Array.from(viewport.querySelectorAll<HTMLElement>('[data-message-id]')).find((item) => {
          const rect = item.getBoundingClientRect()
          const viewportRect = viewport.getBoundingClientRect()
          return rect.bottom > viewportRect.top && rect.top < viewportRect.bottom
        })
      : null
    if (visible && viewport && visible.dataset.messageId) {
      const top = visible.getBoundingClientRect().top - viewportTop
      anchorRef.current = { id: visible.dataset.messageId, top }
      observeAnchor()
    }
    try {
      await onLoad()
    } finally {
      restoreAnchor()
    }
  }

  useEffect(() => () => cancelAnchor(), [cancelAnchor])

  if (!hasMore) return null
  return (
    <div className="mx-auto flex flex-col items-center gap-1">
      {error ? <span className="text-xs text-[var(--aui-danger)]">{error}</span> : null}
      <button type="button" onClick={() => void handleLoad()} disabled={loading} className="rounded-full border border-[var(--aui-border)] px-3 py-1 text-xs text-[var(--aui-muted)] disabled:opacity-60">
        {loading ? 'Loading…' : error ? 'Try again' : 'Load older messages'}
      </button>
    </div>
  )
}

export interface AssistantViewShellProps {
  readonly runtimeStrip: AssistantRuntimeHealth
  readonly streamState: AssistantStreamState
  readonly lastPrompt: string | null
  readonly canSend: boolean
  readonly onRetryLastPrompt: (replay?: boolean) => void | Promise<void>
  readonly conversationRows: AssistantConversationRow[]
  readonly conversationHasMore: boolean
  readonly conversationPageLoading: boolean
  readonly conversationPageError: string | null
  readonly onLoadMoreConversations: () => void | Promise<void>
  readonly sessionIndexLoading: boolean
  readonly sessionIndexError: string | null
  readonly conversationDisabled: boolean
  readonly newConversationDisabled: boolean
  readonly usesLocalConversationHistory: boolean
  readonly onOpenLocalSession: (sessionId: string) => void | Promise<void>
  readonly onOpenPersistedSession: (sessionId: string) => void | Promise<void>
  readonly onNewConversation: () => void | Promise<void>
  readonly sessionMessages: AssistantUiMessage[]
  readonly messagesHasMore: boolean
  readonly messagePageLoading: boolean
  readonly messagePageError: string | null
  readonly onLoadOlderMessages: () => void | Promise<void>
  readonly historyScopeKey: string
  readonly conversationId: string | null
  readonly onReadAssistantMessageAloud: (message: AssistantUiMessage) => void | Promise<void>
  readonly onResolveAssistantToolApproval: (
    tool: AssistantToolCallCard,
    approve: boolean,
    grantScope: AssistantApprovalGrantScope,
  ) => void | Promise<void>
  readonly speakingMessageId: string | null
  readonly executionPeerLabels: Map<string, string>
  readonly streamScopeId: string
  readonly onSubmit: (event: FormEvent<HTMLFormElement>) => void
  readonly voiceCaptureStatus: VoiceCaptureStatus
  readonly mobileHistoryOpen: boolean
  readonly onMobileHistoryOpenChange: (open: boolean) => void
  readonly executionOptions: AssistantExecutionOption[]
  readonly selectedExecution: AssistantExecutionOption
  readonly onExecutionOptionChange: (value: string) => void
  readonly modelChoices: AssistantModelChoice[]
  readonly selectedModelChoice: AssistantModelChoice
  readonly onModelChoiceChange: (value: string) => void
  readonly modelCatalogError: string | null
  readonly modelCatalogLoading: boolean
  readonly modelSearchQuery: string
  readonly onModelSearchQueryChange: (value: string) => void
  readonly modelChoiceGroups: AssistantModelChoiceGroup[]
  readonly modelSourceGroups: AssistantModelSourceGroup[]
  readonly attachments: AssistantAttachmentDraft[]
  readonly contextSummary: { ready: number; blocked: number }
  readonly attachmentInputRef: RefObject<HTMLInputElement | null>
  readonly attachmentPickerAccept: string
  readonly canAttach: boolean
  readonly onFileInput: (files: FileList | null) => void | Promise<void>
  readonly onRemoveAttachment: (id: string) => void
  readonly onOpenAttachmentPicker: () => void | Promise<void>
  readonly connectedVoiceAccessGranted: boolean
  readonly remoteAudioConsentPending: boolean
  readonly onToggleRemoteAudioConsent: () => void | Promise<void>
  readonly textAreaRef: RefObject<HTMLTextAreaElement | null>
  readonly text: string
  readonly onTextChange: (value: string) => void
  readonly onComposerKeyDown: (event: KeyboardEvent<HTMLTextAreaElement>) => void
  readonly routeDisabled: boolean
  readonly voiceModel: AssistantVoiceModel
  readonly voiceElapsedSeconds: number
  readonly nativeMobileBackgroundOwnsMicrophone: boolean
  readonly onRequestVoiceToggle: () => void
  readonly voiceCaptureButtonLabel: string
  readonly usesNativeDesktopVoice: boolean
  readonly handsFreeControl: VoiceControlModel | undefined
  readonly handsFreeActive: boolean
  readonly onToggleNativeDesktopBackgroundWake: () => void | Promise<boolean>
  readonly primaryComposerAction: 'send' | 'stop' | 'retry'
  readonly primaryComposerDisabled: boolean
  readonly primaryComposerAriaLabel: string
  readonly primaryComposerLabel: string
  readonly onPrimaryComposerAction: () => void | Promise<void>
  readonly lastError: string | null
}

export function AssistantViewShell({
  runtimeStrip,
  streamState,
  lastPrompt,
  canSend,
  onRetryLastPrompt,
  conversationRows,
  conversationHasMore,
  conversationPageLoading,
  conversationPageError,
  onLoadMoreConversations,
  sessionIndexLoading,
  sessionIndexError,
  conversationDisabled,
  newConversationDisabled,
  usesLocalConversationHistory,
  onOpenLocalSession,
  onOpenPersistedSession,
  onNewConversation,
  sessionMessages,
  messagesHasMore,
  messagePageLoading,
  messagePageError,
  onLoadOlderMessages,
  historyScopeKey,
  conversationId,
  onReadAssistantMessageAloud,
  onResolveAssistantToolApproval,
  speakingMessageId,
  executionPeerLabels,
  streamScopeId,
  onSubmit,
  voiceCaptureStatus,
  mobileHistoryOpen,
  onMobileHistoryOpenChange,
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
}: AssistantViewShellProps) {
  const threadViewportRef = useRef<HTMLDivElement | null>(null)
  const stableReadAssistantMessageAloud = useStableEvent((message: AssistantUiMessage): void => {
    void onReadAssistantMessageAloud(message)
  })
  const stableResolveAssistantToolApproval = useStableEvent((
    tool: AssistantToolCallCard,
    approve: boolean,
    grantScope: AssistantApprovalGrantScope,
  ): void => {
    void onResolveAssistantToolApproval(tool, approve, grantScope)
  })
  const handleSelectConversation = (sessionId: string) => {
    if (usesLocalConversationHistory) {
      void onOpenLocalSession(sessionId)
    } else {
      void onOpenPersistedSession(sessionId)
    }
  }
  const handleComposerSelectConversation = (sessionId: string) => {
    if (usesLocalConversationHistory) {
      void onOpenLocalSession(sessionId)
    } else {
      void Promise.resolve(onOpenPersistedSession(sessionId)).finally(() => onMobileHistoryOpenChange(false))
    }
  }

  return (
    <section className="aui-assistant flex h-full min-h-0 flex-col gap-0 overflow-hidden [@media(max-width:720px)]:h-auto [@media(max-width:720px)]:min-h-[calc(100dvh-3.5rem)] [@media(max-width:720px)]:overflow-visible" aria-labelledby="assistant-title">
      <h1 id="assistant-title" className="sr-only">Text chat with Aurora</h1>
      <AssistantRuntimeStrip health={runtimeStrip} />

      {streamState.status === 'lost' || streamState.status === 'fallback' || streamState.status === 'cancelled' ? (
        <div
          className="sticky top-0 z-[12] mx-auto mt-3 flex w-[min(48rem,calc(100%_-_2rem))] min-w-0 flex-wrap items-start gap-[0.6rem] rounded-[0.5rem] border border-[color-mix(in_srgb,var(--aui-warning)_36%,var(--aui-border))] bg-[color-mix(in_srgb,var(--aui-warning)_8%,var(--aui-surface))] px-3 py-[0.65rem] text-[var(--aui-ink)] [@media(min-width:861px)]:items-center"
          role="status"
          aria-live="polite"
        >
          <WifiOff size={17} aria-hidden />
          <span className="min-w-0 [overflow-wrap:anywhere]">{streamState.message}</span>
          <button
            type="button"
            className="ml-0 inline-flex items-center gap-[0.35rem] rounded-[0.45rem] border border-[var(--aui-border)] bg-[var(--aui-surface)] px-[0.6rem] py-[0.45rem] text-[var(--aui-ink)] !font-[750] disabled:cursor-not-allowed disabled:opacity-[0.58] [@media(min-width:861px)]:ml-auto"
            onClick={() => void onRetryLastPrompt(streamState.status !== 'cancelled')}
            disabled={!lastPrompt || !canSend}
          >
            <RotateCcw size={15} aria-hidden />
            <span>{streamState.status === 'cancelled' ? 'Retry' : 'Replay'}</span>
          </button>
        </div>
      ) : null}

      <div data-aurora-part="assistant-grid" className="grid flex-auto min-h-0 grid-cols-[256px_minmax(0,1fr)] items-stretch gap-0 [@media(max-width:760px)]:grid-cols-[minmax(0,1fr)] [@media(min-width:1041px)_and_(max-width:1100px)]:flex [@media(min-width:1041px)_and_(max-width:1100px)]:grid-cols-none [@media(max-width:1040px)]:flex [@media(max-width:1040px)]:grid-cols-none [@media(max-width:1040px)]:gap-0 [@media(max-width:720px)]:h-auto [@media(max-width:720px)]:min-h-0 [@media(max-width:720px)]:flex-auto">
        <ConversationRail
          rows={conversationRows}
          loading={sessionIndexLoading}
          error={sessionIndexError}
          hasMore={conversationHasMore}
          pageLoading={conversationPageLoading}
          pageError={conversationPageError}
          disabled={conversationDisabled}
          newConversationDisabled={newConversationDisabled}
          onSelectConversation={handleSelectConversation}
          onNewConversation={() => void onNewConversation()}
          onLoadMore={() => void onLoadMoreConversations()}
        />

        <div
          data-aurora-part="assistant-workspace"
          className="[--aui-chat-width:min(100%,calc(100%_-_3rem))] relative flex min-h-0 min-w-0 flex-1 flex-col gap-0 overflow-hidden [@media(min-width:1041px)_and_(max-width:1100px)]:order-0 [@media(min-width:1041px)_and_(max-width:1100px)]:flex-auto [@media(min-width:1041px)_and_(max-width:1100px)]:min-w-0 [@media(max-width:1040px)]:order-0 [@media(max-width:1040px)]:flex-auto [@media(max-width:1040px)]:min-w-0 [@media(max-width:720px)]:[--aui-chat-width:100%] [@media(max-width:720px)]:min-h-0 [@media(max-width:720px)]:overflow-x-hidden [@media(max-width:720px)]:overscroll-x-none [@media(max-width:720px)]:pb-0"
          data-first-viewport-work="assistant-chat-composer"
          aria-label="Primary chat workspace"
        >
          <MessageScrollerProvider autoScroll>
            <MessageScroller
              data-aurora-part="assistant-thread"
              className="[--aui-chat-width:42rem] flex min-h-0 min-w-0 flex-1 flex-col gap-[1.15rem] overflow-hidden rounded-none border-0 bg-transparent p-0 [@media(max-width:720px)]:w-full [@media(max-width:720px)]:gap-4 [@media(max-width:720px)]:overflow-hidden [@media(max-width:720px)]:p-0 [@media(max-width:720px)]:scroll-pb-0"
              aria-label="Assistant conversation thread"
              aria-live="polite"
            >
              <MessageScrollerViewport ref={threadViewportRef} preserveScrollOnPrepend className="w-full min-h-0 flex-auto [@media(max-width:720px)]:w-full [@media(max-width:720px)]:[scrollbar-gutter:auto] [@media(max-width:720px)]:[scrollbar-width:none] [@media(max-width:720px)]:[-ms-overflow-style:none] [@media(max-width:720px)]:[&::-webkit-scrollbar]:hidden [@media(max-width:720px)]:[&::-webkit-scrollbar]:size-0">
                <AssistantOlderMessagesControl
                  viewportRef={threadViewportRef}
                  conversationId={conversationId}
                  streamScopeId={streamScopeId}
                  historyScopeKey={historyScopeKey}
                  hasMore={messagesHasMore}
                  loading={messagePageLoading}
                  error={messagePageError}
                  onLoad={onLoadOlderMessages}
                />
                <Profiler id="assistant.thread" onRender={assistantThreadProfilerOnRender}>
                  <MessageScrollerContent className="box-border w-full gap-6 px-[max(1rem,clamp(1rem,1.8vw,1.6rem))] py-6 [@media(max-width:720px)]:w-full [@media(max-width:720px)]:px-2 [@media(max-width:720px)]:pt-6 [@media(max-width:720px)]:pb-5">
                    {sessionMessages.length === 0 ? (
                      <MessageScrollerItem messageId="assistant-empty">
                        <Marker className="grid min-h-full w-[min(100%,var(--aui-chat-width))] place-content-center gap-2 text-center text-[var(--aui-muted)] [@media(max-width:720px)]:hidden" variant="border">
                          <MarkerContent>
                            <strong>Start with a prompt</strong>
                            <span>Aurora will show responses here after it finishes answering.</span>
                          </MarkerContent>
                        </Marker>
                      </MessageScrollerItem>
                    ) : (
                      sessionMessages.map((message) => (
                        <MessageScrollerItem key={message.id} messageId={message.id}>
                          <ChatBubble
                            message={message}
                            onReadAloud={stableReadAssistantMessageAloud}
                            onResolveToolApproval={stableResolveAssistantToolApproval}
                            speakingMessageId={speakingMessageId}
                            executionPeerLabels={executionPeerLabels}
                            streamScopeId={streamScopeId}
                          />
                        </MessageScrollerItem>
                      ))
                    )}
                  </MessageScrollerContent>
                </Profiler>
              </MessageScrollerViewport>
              <MessageScrollerButton />
            </MessageScroller>
          </MessageScrollerProvider>

          <Profiler id="assistant.composer" onRender={assistantComposerProfilerOnRender}>
            <AssistantComposer
              onSubmit={onSubmit}
              voiceCaptureStatus={voiceCaptureStatus}
              mobileHistoryOpen={mobileHistoryOpen}
              onMobileHistoryOpenChange={onMobileHistoryOpenChange}
              conversationRows={conversationRows}
              conversationHasMore={conversationHasMore}
              conversationPageLoading={conversationPageLoading}
              conversationPageError={conversationPageError}
              onLoadMoreConversations={onLoadMoreConversations}
              sessionIndexLoading={sessionIndexLoading}
              sessionIndexError={sessionIndexError}
              conversationDisabled={conversationDisabled}
              newConversationDisabled={newConversationDisabled}
              onSelectConversation={handleComposerSelectConversation}
              onNewConversation={() => void onNewConversation()}
              executionOptions={executionOptions}
              selectedExecution={selectedExecution}
              onExecutionOptionChange={onExecutionOptionChange}
              modelChoices={modelChoices}
              selectedModelChoice={selectedModelChoice}
              onModelChoiceChange={onModelChoiceChange}
              modelCatalogError={modelCatalogError}
              modelCatalogLoading={modelCatalogLoading}
              modelSearchQuery={modelSearchQuery}
              onModelSearchQueryChange={onModelSearchQueryChange}
              modelChoiceGroups={modelChoiceGroups}
              modelSourceGroups={modelSourceGroups}
              attachments={attachments}
              contextSummary={contextSummary}
              attachmentInputRef={attachmentInputRef}
              attachmentPickerAccept={attachmentPickerAccept}
              canAttach={canAttach}
              onFileInput={onFileInput}
              onRemoveAttachment={onRemoveAttachment}
              onOpenAttachmentPicker={onOpenAttachmentPicker}
              connectedVoiceAccessGranted={connectedVoiceAccessGranted}
              remoteAudioConsentPending={remoteAudioConsentPending}
              onToggleRemoteAudioConsent={onToggleRemoteAudioConsent}
              textAreaRef={textAreaRef}
              text={text}
              onTextChange={onTextChange}
              onComposerKeyDown={onComposerKeyDown}
              canSend={canSend}
              routeDisabled={routeDisabled}
              voiceModel={voiceModel}
              voiceElapsedSeconds={voiceElapsedSeconds}
              nativeMobileBackgroundOwnsMicrophone={nativeMobileBackgroundOwnsMicrophone}
              onRequestVoiceToggle={onRequestVoiceToggle}
              voiceCaptureButtonLabel={voiceCaptureButtonLabel}
              usesNativeDesktopVoice={usesNativeDesktopVoice}
              handsFreeControl={handsFreeControl}
              handsFreeActive={handsFreeActive}
              onToggleNativeDesktopBackgroundWake={onToggleNativeDesktopBackgroundWake}
              primaryComposerAction={primaryComposerAction}
              primaryComposerDisabled={primaryComposerDisabled}
              primaryComposerAriaLabel={primaryComposerAriaLabel}
              primaryComposerLabel={primaryComposerLabel}
              onPrimaryComposerAction={onPrimaryComposerAction}
              lastError={lastError}
            />
          </Profiler>
        </div>
      </div>
    </section>
  )
}

function useStableEvent<Args extends readonly unknown[], Result>(
  handler: (...args: Args) => Result,
): (...args: Args) => Result {
  const handlerRef = useRef(handler)
  handlerRef.current = handler
  return useMemo(() => (...args: Args) => handlerRef.current(...args), [])
}
