'use client'

import { Profiler, memo, useState } from 'react'
import { Copy, StopCircle, Volume2 } from 'lucide-react'
import type { ModelRuntimeProviderInfo } from '@aurora/client'
import type { RouteAvailability } from './shell-data'
import { Bubble, BubbleContent } from '#components/ui/bubble'
import { Button } from '#components/ui/button'
import { Message, MessageContent, MessageFooter, MessageHeader } from '#components/ui/message'
import { Spinner } from '#components/ui/spinner'
import { ASSISTANT_RESPONDING_TEXT, isAssistantPendingText, isAssistantPendingWork, isAuroraErrorCode } from './assistant-session-model'
import { cn } from '#lib/utils'
import { selectAssistantStreamingText, useAssistantStreamStore } from './state/assistant-stream-store'
import type { AssistantApprovalGrantScope, AssistantToolCallCard, AssistantUiMessage } from './assistant-view'
import { AssistantToolCallCardView } from './assistant-tool-call-card'
import { createAuroraReactProfilerOnRender } from './react-profiler'

const assistantMessageProfilerOnRender = createAuroraReactProfilerOnRender('assistant.message')

export {
  isAssistantToolCallCard,
  metadataObjectValue,
  metadataStringValue,
  toolSummaryForStatus,
  upsertAssistantToolCall,
} from './assistant-session-model'

export const ChatBubble = memo(function ChatBubble({
  message,
  onReadAloud,
  onResolveToolApproval,
  speakingMessageId,
  executionPeerLabels,
  streamScopeId
}: {
  message: AssistantUiMessage
  onReadAloud?: (message: AssistantUiMessage) => void
  onResolveToolApproval?: ((tool: AssistantToolCallCard, approve: boolean, grantScope: AssistantApprovalGrantScope) => void) | undefined
  speakingMessageId?: string | null
  executionPeerLabels?: ReadonlyMap<string, string>
  streamScopeId: string
}) {
  const [copied, setCopied] = useState(false)
  const streamingText = useAssistantStreamStore(selectAssistantStreamingText(message.id, streamScopeId))
  const renderedMessage = streamingText === null ? message : { ...message, text: streamingText }
  const assistant = renderedMessage.role === 'assistant'
  const runtimeLabel = assistantMessageRuntimeLabel(renderedMessage, executionPeerLabels)
  const align = renderedMessage.role === 'user' ? 'end' : 'start'
  const variant = renderedMessage.role === 'user' ? 'tinted' : assistant ? 'outline' : 'muted'
  const isSpeaking = speakingMessageId === renderedMessage.id
  const hasMessageText = renderedMessage.text.trim().length > 0
  const hasToolCards = (renderedMessage.toolCalls?.length ?? 0) > 0
  const assistantPending = isAssistantPendingWork(renderedMessage)
  const isToolOnlyMessage = hasToolCards && (renderedMessage.role === 'tool' || (assistant && isAssistantToolOnlyText(renderedMessage.text)))
  const toolCards = renderedMessage.toolCalls?.length ? (
    <div className="mb-[0.35rem] mt-0 flex flex-col gap-2" aria-label="Assistant tool call cards">
      {renderedMessage.toolCalls.map((tool) => (
        <AssistantToolCallCardView
          key={tool.id}
          tool={tool}
          onResolveToolApproval={onResolveToolApproval}
        />
      ))}
    </div>
  ) : null
  function copyMessageText() {
    if (typeof navigator !== 'undefined') {
      void navigator.clipboard?.writeText(renderedMessage.text)
    }
    setCopied(true)
    if (typeof window !== 'undefined') window.setTimeout(() => setCopied(false), 1100)
  }
  if (isToolOnlyMessage && toolCards) {
    return (
      <Profiler id="assistant.message" onRender={assistantMessageProfilerOnRender}>
        <Message align="start" className="w-full max-w-none rounded-[1rem_1rem_1rem_0.25rem] bg-transparent">
          <MessageContent className="mr-auto max-w-[min(100%,42rem)] items-start gap-[0.45rem]">
            {toolCards}
          </MessageContent>
        </Message>
      </Profiler>
    )
  }
  return (
    <Profiler id="assistant.message" onRender={assistantMessageProfilerOnRender}>
      <Message
        align={align}
        data-aurora-assistant-error-code={assistant && renderedMessage.status === 'failed' && isAuroraErrorCode(renderedMessage.errorCode)
          ? renderedMessage.errorCode
          : undefined}
        className={cn(
          'w-full max-w-none bg-transparent',
          renderedMessage.role === 'user'
            ? 'rounded-[1rem_1rem_0.25rem_1rem] border-0 border-[color-mix(in_srgb,var(--aui-primary)_28%,var(--aui-border))] px-4 py-[0.7rem]'
            : 'rounded-[1rem_1rem_1rem_0.25rem]'
        )}
      >
        <MessageContent className={cn('gap-[0.45rem]', renderedMessage.role === 'user' ? 'ml-auto max-w-[min(100%,84%)] items-end [@media(max-width:720px)]:max-w-[92%]' : 'mr-auto max-w-[min(100%,42rem)] items-start')}>
          <MessageHeader className={cn('max-w-full min-w-0 items-center gap-2 px-3 !text-[0.76rem] !leading-[1.2] text-[var(--aui-muted)] normal-case', renderedMessage.role === 'user' && 'hidden')}>
            <strong className={cn(
              'inline-flex size-6 min-h-6 items-center justify-center font-[850] rounded-[0.45rem] border-0 bg-[color-mix(in_srgb,var(--aui-primary)_15%,transparent)] p-0 text-[var(--aui-primary)]',
              assistant ? "text-[length:0px] after:text-[0.6rem] after:content-['AI']" : 'text-[0.6rem]'
            )}>{assistant ? 'Aurora' : messageRoleLabel(message.role)}</strong>
            {assistant ? <span className="inline-flex min-w-0 max-w-full items-center overflow-hidden text-ellipsis whitespace-nowrap border-0 bg-transparent p-0 font-mono text-[0.72rem] leading-[1.35] text-[var(--aui-muted)]">{runtimeLabel}</span> : <span>{renderedMessage.status}</span>}
            {assistant ? <span className="sr-only">Aurora · {renderedMessage.status}</span> : null}
          </MessageHeader>
          {assistant ? toolCards : null}
          {hasMessageText || assistantPending ? (
            <Bubble align={align} variant={variant} className={cn('w-fit max-w-full', renderedMessage.role === 'user' && 'ml-auto')}>
              <BubbleContent className={cn(
                'w-auto max-w-full rounded-[1rem_1rem_1rem_0.25rem] !border-0 ![background:var(--aui-surface-2)] px-4 py-3 !text-[0.85rem] !leading-[1.6] !text-[var(--aui-ink)] !shadow-none [@media(max-width:720px)]:max-w-full [@media(max-width:720px)]:!text-[0.85rem]',
                renderedMessage.role === 'user' && 'rounded-[1rem_1rem_0.25rem_1rem] ![background:color-mix(in_srgb,var(--aui-primary)_15%,transparent)] !text-[var(--aui-ink)]'
              )}>
                {assistantPending ? (
                  <div className="flex items-center gap-2" role="status" aria-busy={assistantPending}>
                    <Spinner aria-hidden="true" />
                    <span>{isAssistantPendingText(renderedMessage.text) ? renderedMessage.text : ASSISTANT_RESPONDING_TEXT}</span>
                  </div>
                ) : <p className="m-0 whitespace-pre-wrap [overflow-wrap:anywhere] leading-[1.55]">{renderedMessage.text}</p>}
                {renderedMessage.sources?.length ? (
                  <div className="ml-[0.45rem] mt-[0.45rem] flex flex-wrap items-center gap-[0.45rem] text-[0.76rem] text-[var(--aui-muted)] [@media(max-width:720px)]:text-[0.74rem]"><span>Sources:</span>{renderedMessage.sources.map((source) => <code className="rounded-full border border-border bg-muted/60 px-[0.48rem] py-[0.12rem] text-[0.7rem] text-[var(--aui-ink)]" key={source}>{source}</code>)}</div>
                ) : null}
              </BubbleContent>
            </Bubble>
          ) : null}
          {assistant && hasMessageText && !assistantPending ? (
            <MessageFooter className="mt-[0.15rem] flex flex-wrap gap-[0.45rem] px-3 !text-[0.75rem] !leading-4 [@media(max-width:720px)]:!text-[0.74rem] [@media(max-width:720px)]:!leading-[calc(4/3)]" aria-label="Assistant message actions">
              <Button type="button" variant="ghost" size="xs" onClick={copyMessageText} className="min-h-[1.75rem] gap-[0.28rem] rounded-full border border-transparent bg-transparent !px-[0.55rem] py-0 !text-[0.74rem] !leading-[calc(4/3)] text-[var(--aui-muted)] hover:border-[var(--aui-border)] hover:bg-[color-mix(in_srgb,var(--aui-surface-2)_70%,transparent)] hover:text-[var(--aui-ink)]">
                <Copy size={12} aria-hidden data-icon="inline-start" />
                <span>{copied ? 'Copied' : 'Copy'}</span>
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="xs"
                onClick={() => onReadAloud?.(renderedMessage)}
                disabled={!renderedMessage.text.trim() || renderedMessage.status === 'streaming'}
                className="min-h-[1.75rem] gap-[0.28rem] rounded-full border border-transparent bg-transparent !px-[0.55rem] py-0 !text-[0.74rem] !leading-[calc(4/3)] text-[var(--aui-muted)] hover:border-[var(--aui-border)] hover:bg-[color-mix(in_srgb,var(--aui-surface-2)_70%,transparent)] hover:text-[var(--aui-ink)]"
                data-speaking={isSpeaking ? 'true' : undefined}
                aria-pressed={isSpeaking}
              >
                {isSpeaking ? <StopCircle size={12} aria-hidden data-icon="inline-start" /> : <Volume2 size={12} aria-hidden data-icon="inline-start" />}
                <span>{isSpeaking ? 'Stop' : 'Read aloud'}</span>
              </Button>
            </MessageFooter>
          ) : null}
        </MessageContent>
      </Message>
    </Profiler>
  )
})

function isAssistantToolOnlyText(value: string): boolean {
  const normalized = value.replace(/\s+/gu, ' ').trim().toLowerCase()
  if (!normalized) return true
  return normalized === 'aurora paused for a tool approval decision.'
    || normalized === 'aurora is using a tool.'
    || normalized === 'aurora is finished using a tool.'
    || normalized === 'aurora is reporting a tool error.'
    || normalized === 'this action was waiting for approval.'
    || normalized === 'this action did not finish.'
    || normalized === 'this action was cancelled.'
    || normalized === 'action completed.'
}

function messageRoleLabel(role: AssistantUiMessage['role']): string {
  if (role === 'user') return 'You'
  if (role === 'assistant') return 'Aurora'
  if (role === 'system') return 'System'
  return 'Tool'
}

export function assistantMessageRuntimeLabel(
  message: AssistantUiMessage,
  executionPeerLabels: ReadonlyMap<string, string> = new Map()
): string {
  const execution = safeAssistantRuntimeValue(
    message.routeLabel || (message.executionPeerId ? executionPeerLabels.get(message.executionPeerId) ?? null : null),
    message.executionPeerId ? 'Connected Aurora device' : 'Local'
  ) ?? 'Local'
  const model = safeAssistantRuntimeValue(message.modelLabel, null)
  return model && execution !== model ? `${execution} · ${model}` : execution
}

export function safeAssistantRuntimeValue(value: string | null | undefined, fallback: string | null): string | null {
  const trimmed = value?.trim()
  if (!trimmed) return fallback
  if (isInternalAssistantLabel(trimmed)) return fallback
  return trimmed
}

export function isInternalAssistantLabel(value: string): boolean {
  return /\b(?:mock|transport|fallback|runtime|provider|consumer|hybrid|manifest|schema|protocol|sidecar|thin|signaling|datachannel|gateway|orchestrator|tooling|stt|tts|db)\b/i.test(value)
    || /[a-z]+:\/\/|[A-Z][A-Za-z]+\.[A-Z][A-Za-z]+|[{"]|secret|token/i.test(value)
}

export function productConnectionCopy(value: string | null | undefined): string {
  const normalized = (value ?? '').trim().toLowerCase()
  if (!normalized) return 'Connection status pending'
  if (normalized.includes('tauri') || normalized.includes('native') || normalized.includes('local') || normalized.includes('mock')) return 'Connected on this device'
  if (normalized.includes('web') || normalized.includes('http') || normalized.includes('remote')) return 'Connected to Aurora'
  return 'Connection status ready'
}

export function assistantRouteModeLabel(route: RouteAvailability): string {
  if (route.state === 'available-local') return 'Local'
  if (route.state === 'available-remote') return /mesh|peer/i.test(route.providerLabel) ? 'Mesh' : 'Remote'
  if (/mesh|peer/i.test(route.providerLabel)) return 'Mesh'
  if (/openai|cloud|remote/i.test(route.providerLabel)) return 'Remote'
  return route.providerLabel
}

export function assistantRouteProviderCopy(route: RouteAvailability): string {
  if (route.state === 'available-remote' || /mesh|peer|remote|cloud/i.test(route.providerLabel)) return 'Connected Aurora device'
  return 'This device'
}

export function assistantRouteBlockerCopy(route: RouteAvailability): string {
  const raw = `${route.state} ${route.blockers.join(' ')} ${route.explanation}`.toLowerCase()
  if (/auth|permission|denied|forbidden/.test(raw)) return 'Review access before continuing'
  if (/privacy|consent|selector/.test(raw)) return 'Make the required privacy choice before continuing'
  if (/offline|timeout|stale|unavailable|unsupported|missing/.test(raw)) return 'This assistant route is unavailable right now'
  return 'This assistant route is unavailable right now'
}

export function selectedRuntimeProvider(
  provider: ModelRuntimeProviderInfo | null,
  providers: ModelRuntimeProviderInfo[]
): ModelRuntimeProviderInfo | null {
  return provider ?? providers.find((candidate) => candidate.selected) ?? null
}
