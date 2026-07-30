'use client'

import { Archive, Database, RefreshCw, Trash2 } from 'lucide-react'
import type { ConversationMessageRecord, LocalConversationSummary, LocalMemoryItem } from '@aurora/client/local-data'

import { Badge } from '#components/ui/badge'
import { Button } from '#components/ui/button'
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle
} from '#components/ui/card'
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '#components/ui/empty'
import { Alert, AlertDescription, AlertTitle } from '#components/ui/alert'
import {
  Message,
  MessageContent,
  MessageFooter,
  MessageHeader
} from '#components/ui/message'
import {
  MessageScroller,
  MessageScrollerContent,
  MessageScrollerItem,
  MessageScrollerProvider,
  MessageScrollerViewport
} from '#components/ui/message-scroller'
import { Bubble, BubbleContent } from '#components/ui/bubble'

import { PRODUCT_COPY } from '../product-copy.js'
import type { ProductCopyResult } from '../product-copy.js'
import { useOptionalLocalData, type LocalDataProductError } from './local-data-provider.js'
import type { BrowserStorageHealth } from './storage-health.js'
import { useLocalConversations } from './use-local-conversations.js'
import { useLightweightMemory } from './use-lightweight-memory.js'

export interface StorageHealthViewProps {
  readonly health?: BrowserStorageHealth | undefined
  readonly loading?: boolean | undefined
  readonly error?: StorageHealthProductError | null | undefined
  readonly onRetry?: (() => void) | undefined
}

export type StorageHealthProductError = ProductCopyResult | LocalDataProductError

export function StorageHealthView({ health: healthProp, loading = false, error = null, onRetry }: StorageHealthViewProps) {
  const localData = useOptionalLocalData()
  const health = healthProp ?? localData?.storageHealth ?? null
  if (health === null) return null
  const copy = storageProductCopy(health)
  const productError = storageHealthProductError(error)

  return (
    <Card size="sm" aria-label="Local data status">
      <CardHeader>
        <CardTitle>{copy.title}</CardTitle>
        <CardDescription>{copy.detail}</CardDescription>
        {onRetry || localData?.reopen ? (
          <CardAction>
            <Button type="button" variant="outline" size="sm" disabled={loading} onClick={onRetry ?? localData?.reopen}>
              <RefreshCw data-icon="inline-start" aria-hidden />
              Try again
            </Button>
          </CardAction>
        ) : null}
      </CardHeader>
      {error ? (
        <CardContent>
          <Alert variant="destructive">
            <AlertTitle>{copy.alertTitle}</AlertTitle>
            <AlertDescription>{productError.description ?? productError.title}</AlertDescription>
          </Alert>
        </CardContent>
      ) : null}
    </Card>
  )
}

export function LocalDataMemoryPanel() {
  const localData = useOptionalLocalData()
  if (localData === null) return null

  return <LocalDataMemoryPanelContent />
}

function LocalDataMemoryPanelContent() {
  const localData = useOptionalLocalData()
  const conversations = useLocalConversations({ limit: 6, messageLimit: 8 })
  const memory = useLightweightMemory({ limit: 8 })
  const selectedId = conversations.selectedConversationId
  const messages = selectedId ? conversations.messagesByConversation.get(selectedId) ?? [] : []
  const selectedSummary = selectedId
    ? conversations.summaries.find((summary) => summary.record.id === selectedId) ?? null
    : null
  const error = localData?.error ?? localHookProductError(conversations.error ?? memory.error)

  return (
    <section className="flex flex-col gap-3" aria-labelledby="local-data-title">
      <div className="flex flex-col gap-1">
        <h2 id="local-data-title" className="text-sm font-semibold">This device</h2>
        <p className="text-sm text-muted-foreground">
          Recent activity saved here stays separate from the connected Aurora device until you choose to move it.
        </p>
      </div>

      <StorageHealthView loading={conversations.loading || memory.loading} error={error} />

      <div className="grid grid-cols-1 gap-3 lg:grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)]">
        <Card size="sm" aria-label="This device conversations">
          <CardHeader>
            <CardTitle>Conversations on this device</CardTitle>
            <CardDescription>{conversationCountCopy(conversations.summaries)}</CardDescription>
            <CardAction>
              <Button type="button" variant="ghost" size="icon-sm" aria-label="Refresh this device history" onClick={() => void conversations.refresh()}>
                <RefreshCw aria-hidden />
              </Button>
            </CardAction>
          </CardHeader>
          <CardContent className="flex flex-col gap-2">
            {conversations.summaries.length === 0 ? (
              <Empty className="min-h-[160px]">
                <EmptyHeader>
                  <EmptyMedia variant="icon"><Archive aria-hidden /></EmptyMedia>
                  <EmptyTitle>No conversations on this device</EmptyTitle>
                  <EmptyDescription>New local conversations will appear here.</EmptyDescription>
                </EmptyHeader>
              </Empty>
            ) : (
              conversations.summaries.map((summary) => (
                <ConversationSummaryRow
                  key={summary.record.id}
                  summary={summary}
                  active={summary.record.id === selectedId}
                  onArchive={() => void conversations.archiveConversation(summary.record.id)}
                  onDelete={() => void conversations.deleteConversation(summary.record.id)}
                />
              ))
            )}
          </CardContent>
        </Card>

        <Card size="sm" aria-label="This device transcript">
          <CardHeader>
            <CardTitle>{selectedSummary ? conversationTitle(selectedSummary.record.id) : 'Local conversation'}</CardTitle>
            <CardDescription>{selectedSummary ? `${selectedSummary.messageCount.toLocaleString()} saved messages` : 'Choose a local conversation to review.'}</CardDescription>
          </CardHeader>
          <CardContent>
            {messages.length === 0 ? (
              <Empty className="min-h-[220px]">
                <EmptyHeader>
                  <EmptyMedia variant="icon"><Database aria-hidden /></EmptyMedia>
                  <EmptyTitle>No local messages</EmptyTitle>
                  <EmptyDescription>Saved messages for this conversation will appear here.</EmptyDescription>
                </EmptyHeader>
              </Empty>
            ) : (
              <LocalMessageTranscript messages={messages} />
            )}
          </CardContent>
        </Card>
      </div>

      <Card size="sm" aria-label="This device memory">
        <CardHeader>
          <CardTitle>Memory on this device</CardTitle>
          <CardDescription>{memoryCountCopy(memory.items)}</CardDescription>
          <CardAction>
            <Button type="button" variant="outline" size="sm" onClick={() => void memory.cleanupExpired()}>
              <Trash2 data-icon="inline-start" aria-hidden />
              Clean up old items
            </Button>
          </CardAction>
        </CardHeader>
        <CardContent>
          {memory.items.length === 0 ? (
            <Empty className="min-h-[150px]">
              <EmptyHeader>
                <EmptyMedia variant="icon"><Database aria-hidden /></EmptyMedia>
                <EmptyTitle>No local memory yet</EmptyTitle>
                <EmptyDescription>Helpful details saved on this device will appear here.</EmptyDescription>
              </EmptyHeader>
            </Empty>
          ) : (
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              {memory.items.map((item) => (
                <LocalMemoryItemCard key={item.record.id} item={item} />
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </section>
  )
}

function ConversationSummaryRow({
  summary,
  active,
  onArchive,
  onDelete
}: {
  readonly summary: LocalConversationSummary
  readonly active: boolean
  readonly onArchive: () => void
  readonly onDelete: () => void
}) {
  return (
    <article className="flex min-w-0 items-center gap-2 rounded-lg border border-border p-2.5 data-[active=true]:border-primary" data-active={active}>
      <div className="min-w-0 flex-1">
        <h3 className="truncate text-sm font-medium">{conversationTitle(summary.record.id)}</h3>
        <p className="text-xs text-muted-foreground">{updatedCopy(summary.record.updatedAtMs)} · {summary.messageCount.toLocaleString()} messages</p>
      </div>
      {summary.record.archivedAtMs === null ? null : <Badge variant="secondary">Archived</Badge>}
      <Button type="button" variant="ghost" size="icon-sm" aria-label={`Archive ${conversationTitle(summary.record.id)}`} onClick={onArchive}>
        <Archive aria-hidden />
      </Button>
      <Button type="button" variant="ghost" size="icon-sm" aria-label={`Delete ${conversationTitle(summary.record.id)}`} onClick={onDelete}>
        <Trash2 aria-hidden />
      </Button>
    </article>
  )
}

function LocalMessageTranscript({ messages }: { readonly messages: ConversationMessageRecord[] }) {
  return (
    <MessageScrollerProvider>
      <MessageScroller className="h-[260px] rounded-lg border border-border">
        <MessageScrollerViewport>
          <MessageScrollerContent className="p-3">
            {messages.map((message) => (
              <MessageScrollerItem key={message.id}>
                <Message align={message.role === 'user' ? 'end' : 'start'}>
                  <MessageContent>
                    <MessageHeader>{messageRoleCopy(message.role)}</MessageHeader>
                    <Bubble variant={message.role === 'user' ? 'default' : 'secondary'}>
                      <BubbleContent>{messageTextCopy(message)}</BubbleContent>
                    </Bubble>
                    <MessageFooter>{messageStatusCopy(message.status)} · {updatedCopy(message.createdAtMs)}</MessageFooter>
                  </MessageContent>
                </Message>
              </MessageScrollerItem>
            ))}
          </MessageScrollerContent>
        </MessageScrollerViewport>
      </MessageScroller>
    </MessageScrollerProvider>
  )
}

function LocalMemoryItemCard({ item }: { readonly item: LocalMemoryItem }) {
  return (
    <article className="flex min-w-0 flex-col gap-2 rounded-lg border border-border p-3">
      <div className="flex items-center justify-between gap-2">
        <h3 className="truncate text-sm font-medium">{memoryTitle(item.record.namespace)}</h3>
        <Badge variant={item.record.expiresAtMs === null ? 'secondary' : 'outline'}>
          {item.record.expiresAtMs === null ? 'Kept' : 'Expires'}
        </Badge>
      </div>
      <p className="text-xs text-muted-foreground">{memorySourceCopy(item.record.sourceType)} · {updatedCopy(item.record.updatedAtMs)}</p>
    </article>
  )
}

function storageProductCopy(health: BrowserStorageHealth): { title: string; detail: string; alertTitle: string } {
  if (health.internalState === 'owner_blocked') {
    return {
      title: PRODUCT_COPY.localData.ownedElsewhere,
      detail: 'Close another Aurora window to change local features here.',
      alertTitle: 'Try again after closing another window'
    }
  }
  if (health.outcome === 'saved_on_this_device' || health.outcome === 'ready') {
    return {
      title: PRODUCT_COPY.localData.saved,
      detail: 'Recent activity stays available on this device.',
      alertTitle: 'Local data needs attention'
    }
  }
  if (health.outcome === 'temporary_session') {
    return {
      title: PRODUCT_COPY.localData.temporary,
      detail: 'Aurora can continue here, but recent activity may be lost when you close Aurora.',
      alertTitle: 'Temporary session'
    }
  }
  return {
    title: PRODUCT_COPY.localData.unchanged,
    detail: 'Aurora kept recent activity unchanged.',
    alertTitle: 'Local data needs attention'
  }
}

function storageHealthProductError(error: StorageHealthProductError | null): ProductCopyResult {
  if (error === null) return { title: PRODUCT_COPY.localData.unchanged }
  const title = safeStructuredCopy(productErrorField(error, 'title'))
  const description = safeStructuredCopy(productErrorField(error, 'description') ?? productErrorField(error, 'detail'))
  return {
    title: title ?? PRODUCT_COPY.localData.unchanged,
    ...(description === undefined ? {} : { description })
  }
}

function productErrorField(error: StorageHealthProductError, field: 'title' | 'description' | 'detail'): string | undefined {
  if (typeof error !== 'object' || error === null) return undefined
  const value = field in error ? error[field as keyof StorageHealthProductError] : undefined
  return typeof value === 'string' ? value : undefined
}

function localHookProductError(error: string | null): StorageHealthProductError | null {
  if (error === null) return null
  if (error === 'Action cancelled') return { title: 'Action cancelled' }
  if (error === 'Local features are already active in another Aurora window') {
    return {
      title: PRODUCT_COPY.localData.ownedElsewhere,
      description: 'Close another Aurora window or try again here.'
    }
  }
  if (error === 'Local data needs attention') {
    return {
      title: 'Local data needs attention',
      description: 'Aurora could not safely use recent activity. Try again.'
    }
  }
  return {
    title: PRODUCT_COPY.localData.unchanged,
    description: 'Aurora kept recent activity unchanged.'
  }
}

function safeStructuredCopy(value: string | null | undefined): string | undefined {
  if (value === undefined || value === null || value.trim() === '') return undefined
  if (value === PRODUCT_COPY.localData.unchanged) return value
  if (value === PRODUCT_COPY.localData.ownedElsewhere) return value
  if (value === PRODUCT_COPY.localData.saved) return value
  if (value === PRODUCT_COPY.localData.temporary) return value
  if (value === 'Action cancelled') return value
  if (value === 'Local data needs attention') return value
  if (value === 'Close another Aurora window or try again here.') return value
  if (value === 'Aurora could not safely use recent activity. Try again.') return value
  if (value === 'Aurora kept recent activity unchanged.') return value
  return PRODUCT_COPY.localData.unchanged
}

function conversationCountCopy(summaries: readonly LocalConversationSummary[]): string {
  if (summaries.length === 0) return 'No local conversations saved yet.'
  return `${summaries.length.toLocaleString()} local conversations saved here.`
}

function memoryCountCopy(items: readonly LocalMemoryItem[]): string {
  if (items.length === 0) return 'No local memory saved yet.'
  return `${items.length.toLocaleString()} local memory items saved here.`
}

function conversationTitle(id: string): string {
  if (/^conversation[-_:/]/iu.test(id)) return `Conversation ${readableId(id, 'Local')}`
  return readableId(id, 'Conversation')
}

function memoryTitle(namespace: string): string {
  return readableId(namespace, 'Memory')
}

function memorySourceCopy(value: string | null): string {
  if (!value || value === 'conversation') return 'Saved from a conversation'
  if (value === 'note') return 'Saved note'
  return 'Saved locally'
}

function messageRoleCopy(role: ConversationMessageRecord['role']): string {
  if (role === 'assistant') return 'Aurora'
  if (role === 'user') return 'You'
  if (role === 'tool') return 'Action'
  return 'Note'
}

function messageStatusCopy(status: ConversationMessageRecord['status']): string {
  if (status === 'complete') return 'Saved'
  if (status === 'pending') return 'Saving'
  if (status === 'cancelled') return 'Cancelled'
  return 'Needs attention'
}

function messageTextCopy(message: ConversationMessageRecord): string {
  if (message.contentEnvelope !== null) return 'Saved message'
  if (message.toolEnvelope !== null) return 'Saved action'
  return 'Saved local entry'
}

function updatedCopy(value: number): string {
  const date = new Date(value)
  if (!Number.isFinite(date.getTime())) return 'Time unavailable'
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}

function readableId(value: string, fallback: string): string {
  const suffix = value.split(/[.:/_-]/u).filter(Boolean).at(-1)
  if (!suffix) return fallback
  return suffix.replace(/\b\w/gu, (letter) => letter.toLocaleUpperCase())
}
