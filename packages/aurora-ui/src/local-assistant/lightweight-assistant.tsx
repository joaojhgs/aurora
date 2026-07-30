import * as React from 'react'
import { CheckIcon, SendIcon, SquareIcon, XIcon } from 'lucide-react'
import {
  createLightweightOrchestrator,
  type LightweightAssistantProvider,
  type LightweightConfirmationEvent,
  type LightweightOrchestrator,
  type LightweightOrchestratorLimits,
  type LightweightToolClientPort,
} from '@aurora/client/lightweight-orchestrator'
import type { EnvelopeCryptoPort, LocalDataScope, LocalDataSession } from '@aurora/client/local-data'
import type { ToolingProjectionToolInfo } from '@aurora/client'

import { Alert, AlertDescription, AlertTitle } from '#components/ui/alert'
import { Bubble, BubbleContent } from '#components/ui/bubble'
import { Button } from '#components/ui/button'
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupTextarea } from '#components/ui/input-group'
import { Marker, MarkerContent, MarkerIcon } from '#components/ui/marker'
import { Message, MessageContent, MessageHeader } from '#components/ui/message'
import {
  MessageScroller,
  MessageScrollerContent,
  MessageScrollerItem,
  MessageScrollerProvider,
  MessageScrollerViewport,
} from '#components/ui/message-scroller'
import { Spinner } from '#components/ui/spinner'
import { cn } from '#lib/utils'
import { safeErrorCopy } from '../product-copy'

export interface LightweightAssistantDependencies {
  readonly provider?: LightweightAssistantProvider | null
  readonly tools?: LightweightToolClientPort | null
  readonly localData?: LocalDataSession | null
  readonly envelopeCrypto?: EnvelopeCryptoPort | null
  readonly scope?: LocalDataScope | null
  readonly availableTools?: readonly ToolingProjectionToolInfo[] | null
  readonly approvalPrincipalId?: string | null
  readonly limits?: Partial<LightweightOrchestratorLimits>
  readonly ids?: () => string
  readonly nowMs?: () => number
}

export interface LightweightAssistantProps extends LightweightAssistantDependencies {
  readonly className?: string
  readonly initialPrompt?: string
}

interface VisibleMessage {
  readonly id: string
  readonly role: 'user' | 'assistant'
  readonly content: string
}

type AssistantPhase = 'idle' | 'running' | 'awaiting-confirmation' | 'cancelling' | 'error'

const EMPTY_STATE = 'Ask Aurora anything available on this device.'
const UNAVAILABLE_TITLE = 'Assistant is unavailable on this device'
const UNAVAILABLE_DETAIL = 'Add assistant access, local data, and secure saving before continuing.'
const ERROR_ACTION = 'Try again'

export function LightweightLocalAssistant({
  className,
  initialPrompt = '',
  provider,
  tools,
  localData,
  envelopeCrypto,
  scope,
  availableTools,
  approvalPrincipalId,
  limits,
  ids,
  nowMs,
}: LightweightAssistantProps) {
  const [prompt, setPrompt] = React.useState(initialPrompt)
  const [messages, setMessages] = React.useState<VisibleMessage[]>([])
  const [phase, setPhase] = React.useState<AssistantPhase>('idle')
  const [errorText, setErrorText] = React.useState<string | null>(null)
  const [confirmation, setConfirmation] = React.useState<LightweightConfirmationEvent | null>(null)
  const abortRef = React.useRef<AbortController | null>(null)

  const orchestrator = React.useMemo<LightweightOrchestrator | null>(() => {
    const readiness = resolveReadiness({ provider, tools, localData, envelopeCrypto, scope, availableTools })
    if (!readiness.ready) return null
    try {
      return createLightweightOrchestrator({
        provider: readiness.provider,
        tools: readiness.tools,
        localData: readiness.localData,
        localDataCrypto: readiness.envelopeCrypto,
        scope: readiness.scope,
        availableTools: readiness.availableTools,
        ...(approvalPrincipalId === undefined ? {} : { approvalPrincipalId }),
        ...(limits === undefined ? {} : { limits }),
        ...(ids === undefined ? {} : { ids }),
        ...(nowMs === undefined ? {} : { nowMs }),
      })
    } catch {
      return null
    }
  }, [approvalPrincipalId, availableTools, envelopeCrypto, ids, limits, localData, nowMs, provider, scope, tools])
  React.useEffect(() => () => abortRef.current?.abort(), [])

  if (orchestrator === null) {
    return (
      <section className={cn('flex min-h-[22rem] flex-col gap-3 rounded-lg border border-border bg-card p-4', className)}>
        <Alert>
          <AlertTitle>{UNAVAILABLE_TITLE}</AlertTitle>
          <AlertDescription>{UNAVAILABLE_DETAIL}</AlertDescription>
        </Alert>
      </section>
    )
  }

  const activeOrchestrator = orchestrator
  const busy = phase === 'running' || phase === 'cancelling'
  const canSubmit = prompt.trim().length > 0 && !busy && confirmation === null

  async function submitTurn(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!canSubmit) return
    const text = prompt.trim()
    const controller = new AbortController()
    abortRef.current = controller
    setPrompt('')
    setErrorText(null)
    setConfirmation(null)
    setPhase('running')
    const userMessage: VisibleMessage = { id: `user-${Date.now()}`, role: 'user', content: text }
    setMessages((current) => [...current, userMessage])
    try {
      const result = await activeOrchestrator.runTurn({ text, signal: controller.signal })
      if (result.status === 'awaiting_confirmation' && result.confirmation) {
        setConfirmation(result.confirmation)
        setPhase('awaiting-confirmation')
        return
      }
      if (result.status === 'cancelled') {
        setPhase('idle')
        return
      }
      setMessages((current) => [...current, { id: `assistant-${result.conversationId}-${current.length}`, role: 'assistant', content: result.assistantText }])
      setPhase('idle')
    } catch (error) {
      setErrorText(safeErrorCopy(error).title)
      setPhase('error')
    } finally {
      if (abortRef.current === controller) abortRef.current = null
    }
  }

  async function decideConfirmation(decision: 'approve' | 'deny') {
    if (confirmation === null) return
    const controller = new AbortController()
    abortRef.current = controller
    setErrorText(null)
    setPhase(decision === 'approve' ? 'running' : 'cancelling')
    try {
      const result = await activeOrchestrator.resumeConfirmation({
        token: confirmation.token,
        decision,
        signal: controller.signal,
      })
      setConfirmation(null)
      if (result.status === 'completed') {
        setMessages((current) => [...current, { id: `assistant-${result.conversationId}-${current.length}`, role: 'assistant', content: result.assistantText }])
      }
      setPhase('idle')
    } catch (error) {
      setErrorText(safeErrorCopy(error).title)
      setPhase('error')
    } finally {
      if (abortRef.current === controller) abortRef.current = null
    }
  }

  function cancelTurn() {
    setPhase('cancelling')
    abortRef.current?.abort()
    activeOrchestrator.cancel(confirmation?.token)
  }

  return (
    <section className={cn('flex min-h-[30rem] flex-col gap-3 rounded-lg border border-border bg-card p-3', className)}>
      <MessageScrollerProvider autoScroll>
        <MessageScroller className="min-h-0 flex-1" aria-label="Assistant conversation" aria-live="polite">
          <MessageScrollerViewport>
            <MessageScrollerContent className="p-1">
              {messages.length === 0 ? (
                <MessageScrollerItem messageId="local-assistant-empty">
                  <Marker>
                    <MarkerContent>{EMPTY_STATE}</MarkerContent>
                  </Marker>
                </MessageScrollerItem>
              ) : null}
              {messages.map((message) => (
                <MessageScrollerItem key={message.id} messageId={message.id} scrollAnchor={message.role === 'user'}>
                  <VisibleTurnMessage message={message} />
                </MessageScrollerItem>
              ))}
              {confirmation ? (
                <MessageScrollerItem messageId={`confirm-${confirmation.token}`} scrollAnchor>
                  <ConfirmationCard confirmation={confirmation} busy={busy} onApprove={() => void decideConfirmation('approve')} onDeny={() => void decideConfirmation('deny')} />
                </MessageScrollerItem>
              ) : null}
              {phase === 'running' ? (
                <MessageScrollerItem messageId="local-assistant-running" scrollAnchor>
                  <Marker>
                    <MarkerIcon>
                      <Spinner />
                    </MarkerIcon>
                    <MarkerContent>Aurora is working.</MarkerContent>
                  </Marker>
                </MessageScrollerItem>
              ) : null}
            </MessageScrollerContent>
          </MessageScrollerViewport>
        </MessageScroller>
      </MessageScrollerProvider>

      {errorText ? (
        <Alert variant="destructive">
          <AlertTitle>{errorText}</AlertTitle>
          <AlertDescription>{ERROR_ACTION}</AlertDescription>
        </Alert>
      ) : null}

      <form onSubmit={(event) => void submitTurn(event)} className="flex flex-col gap-2">
        <InputGroup>
          <InputGroupTextarea
            aria-label="Message Aurora"
            placeholder="Message Aurora"
            value={prompt}
            rows={2}
            disabled={busy || confirmation !== null}
            onChange={(event) => setPrompt(event.currentTarget.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault()
                event.currentTarget.form?.requestSubmit()
              }
            }}
          />
          <InputGroupAddon align="inline-end">
            {busy ? (
              <InputGroupButton aria-label="Stop response" onClick={cancelTurn} variant="outline" size="icon-sm">
                <SquareIcon />
              </InputGroupButton>
            ) : (
              <InputGroupButton aria-label="Send message" type="submit" disabled={!canSubmit} size="icon-sm">
                <SendIcon />
              </InputGroupButton>
            )}
          </InputGroupAddon>
        </InputGroup>
        <p className="text-xs text-muted-foreground">Saved on this device.</p>
      </form>
    </section>
  )
}

function VisibleTurnMessage({ message }: { readonly message: VisibleMessage }) {
  const isUser = message.role === 'user'
  return (
    <Message align={isUser ? 'end' : 'start'}>
      <MessageContent>
        <MessageHeader>{isUser ? 'You' : 'Aurora'}</MessageHeader>
        <Bubble align={isUser ? 'end' : 'start'} variant={isUser ? 'default' : 'secondary'}>
          <BubbleContent>{message.content}</BubbleContent>
        </Bubble>
      </MessageContent>
    </Message>
  )
}

function ConfirmationCard({
  confirmation,
  busy,
  onApprove,
  onDeny,
}: {
  readonly confirmation: LightweightConfirmationEvent
  readonly busy: boolean
  readonly onApprove: () => void
  readonly onDeny: () => void
}) {
  void confirmation
  return (
    <Message align="start">
      <MessageContent>
        <MessageHeader>Aurora needs your approval</MessageHeader>
        <Bubble variant="outline">
          <BubbleContent>
            <div className="flex flex-col gap-3">
              <div className="flex flex-col gap-1">
                <span className="font-medium">Requested action</span>
                <span className="text-muted-foreground">Review this request before Aurora continues.</span>
              </div>
              <div className="flex flex-wrap gap-2">
                <Button size="sm" onClick={onApprove} disabled={busy}>
                  <CheckIcon data-icon="inline-start" />
                  Allow once
                </Button>
                <Button size="sm" variant="outline" onClick={onDeny} disabled={busy}>
                  <XIcon data-icon="inline-start" />
                  Deny
                </Button>
              </div>
            </div>
          </BubbleContent>
        </Bubble>
      </MessageContent>
    </Message>
  )
}

interface DependencyInput {
  readonly provider: LightweightAssistantProvider | null | undefined
  readonly tools: LightweightToolClientPort | null | undefined
  readonly localData: LocalDataSession | null | undefined
  readonly envelopeCrypto: EnvelopeCryptoPort | null | undefined
  readonly scope: LocalDataScope | null | undefined
  readonly availableTools: readonly ToolingProjectionToolInfo[] | null | undefined
}

interface ReadyDependencies {
  readonly provider: LightweightAssistantProvider
  readonly tools: LightweightToolClientPort
  readonly localData: LocalDataSession
  readonly envelopeCrypto: EnvelopeCryptoPort
  readonly scope: LocalDataScope
  readonly availableTools: readonly ToolingProjectionToolInfo[]
}

function resolveReadiness(input: DependencyInput): { ready: false } | ({ ready: true } & ReadyDependencies) {
  if (
    input.provider === undefined ||
    input.provider === null ||
    input.tools === undefined ||
    input.tools === null ||
    input.localData === undefined ||
    input.localData === null ||
    input.envelopeCrypto === undefined ||
    input.envelopeCrypto === null ||
    input.scope === undefined ||
    input.scope === null ||
    input.availableTools === undefined ||
    input.availableTools === null
  ) {
    return { ready: false }
  }
  return {
    ready: true,
    provider: input.provider,
    tools: input.tools,
    localData: input.localData,
    envelopeCrypto: input.envelopeCrypto,
    scope: input.scope,
    availableTools: input.availableTools,
  }
}
