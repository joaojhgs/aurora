'use client'

import { History, MessageSquarePlus } from 'lucide-react'
import { Button } from '#components/ui/button'
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle, SheetTrigger } from '#components/ui/sheet'
import { cn } from '#lib/utils'
import { EvidenceBadge } from './status-badges'
import type { AssistantConversationRow } from './assistant-view'

export function ConversationRail({
  rows,
  loading,
  error,
  pageError,
  hasMore,
  pageLoading,
  disabled,
  newConversationDisabled,
  onSelectConversation,
  onNewConversation,
  onLoadMore
}: {
  rows: AssistantConversationRow[]
  loading: boolean
  error: string | null
  pageError: string | null
  hasMore: boolean
  pageLoading: boolean
  disabled: boolean
  newConversationDisabled: boolean
  onSelectConversation: (sessionId: string) => void
  onNewConversation: () => void
  onLoadMore: () => void
}) {
  return (
    /* Conversation rail */
    <aside data-aurora-part="assistant-conversation-rail" className="[&_[data-slot=badge]]:mt-[0.35rem] [&_time]:text-[0.7rem] flex min-h-0 w-64 flex-[0_0_256px] flex-col gap-0 overflow-hidden border-0 border-r border-[var(--aui-border)] bg-[color-mix(in_srgb,var(--aui-surface-3)_18%,transparent)] p-0 shadow-none [@media(min-width:1041px)_and_(max-width:1100px)]:order-0 [@media(min-width:1041px)_and_(max-width:1100px)]:w-64 [@media(min-width:1041px)_and_(max-width:1100px)]:flex-[0_0_256px] [@media(max-width:1040px)]:hidden" aria-labelledby="assistant-recent-chats-title">
      <h2 id="assistant-recent-chats-title" className="sr-only">Recent chats</h2>
      <header className="flex items-center gap-2.5 border-b border-[var(--aui-border)] p-3">
        <Button type="button" variant="ghost" size="sm" onClick={onNewConversation} disabled={disabled || loading || newConversationDisabled} aria-label="New conversation" className="min-h-8 w-full justify-start gap-[0.35rem] rounded-[0.5rem] border border-[var(--aui-border)] bg-[color-mix(in_srgb,var(--aui-surface-2)_58%,transparent)] px-[0.7rem] py-[0.4rem] !font-extrabold !text-[0.92rem] !text-[var(--aui-ink)] shadow-none">
          <MessageSquarePlus aria-hidden />
          <span>New conversation</span>
        </Button>
      </header>
      <ConversationList
        rows={rows}
        loading={loading}
        error={error}
        disabled={disabled}
        onSelectConversation={onSelectConversation}
      />
      {pageError ? <span className="px-3 py-1 text-xs text-[var(--aui-danger)]">{pageError}</span> : null}
      {hasMore ? <Button type="button" variant="ghost" size="sm" onClick={onLoadMore} disabled={disabled || pageLoading} className="mx-2 mb-2">{pageLoading ? 'Loading conversations…' : pageError ? 'Try again' : 'Load more'}</Button> : null}
    </aside>
  )
}

export function MobileConversationSheet({
  open,
  onOpenChange,
  rows,
  loading,
  error,
  pageError,
  hasMore,
  pageLoading,
  disabled,
  newConversationDisabled,
  onSelectConversation,
  onNewConversation,
  onLoadMore,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  rows: AssistantConversationRow[]
  loading: boolean
  error: string | null
  pageError: string | null
  hasMore: boolean
  pageLoading: boolean
  disabled: boolean
  newConversationDisabled: boolean
  onSelectConversation: (sessionId: string) => void
  onNewConversation: () => void
  onLoadMore: () => void
}) {
  return (
    <div data-aurora-part="assistant-mobile-history-host" className="hidden items-center [@media(max-width:1040px)]:flex">
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetTrigger
        render={(
          <Button
            type="button"
            variant="ghost"
            size="sm"
            data-aurora-part="assistant-mobile-history-trigger"
            className="[@media(min-width:1041px)]:rounded-[0.45rem] [@media(min-width:1041px)]:border-[color-mix(in_srgb,var(--aui-primary)_35%,var(--aui-border))] [@media(min-width:1041px)]:bg-[var(--aui-primary)] [@media(min-width:1041px)]:text-primary-foreground hidden min-h-[2.15rem] w-auto flex-none items-center gap-[0.35rem] rounded-full border border-[color-mix(in_srgb,var(--aui-border)_85%,transparent)] bg-[color-mix(in_srgb,var(--aui-surface-2)_52%,transparent)] px-[0.65rem] !text-[length:0.75rem] !font-[750] !leading-[1.45] text-[color:var(--aui-ink)] [@media(max-width:1040px)]:inline-flex [@media(max-width:720px)]:size-[2.15rem] [@media(max-width:720px)]:min-h-[2.15rem] [@media(max-width:720px)]:min-w-[2.15rem] [@media(max-width:720px)]:justify-center [@media(max-width:720px)]:p-0 [@media(max-width:720px)]:!text-[length:0.72rem] [@media(max-width:720px)]:[&_span]:hidden [@media(max-width:1040px)]:[&_svg]:size-[0.95rem]"
            aria-label="Open conversations"
          />
        )}
      >
        <History className="size-[0.95rem]" aria-hidden />
        <span>Chats</span>
      </SheetTrigger>
      <SheetContent side="left" className="min-h-0 !w-[min(22rem,calc(100vw-1rem))] !max-w-[min(22rem,calc(100vw-1rem))] !gap-0 overflow-hidden border-r border-[var(--aui-border)] !bg-[var(--aui-surface)] px-0 pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)] text-[color:var(--aui-ink)] [&_[data-slot=sheet-description]]:text-[color:var(--aui-muted)] [&_[data-slot=sheet-header]]:flex-none [&_[data-slot=sheet-header]]:border-b [&_[data-slot=sheet-header]]:border-[var(--aui-border)] [&_[data-slot=sheet-header]]:pt-4 [&_[data-slot=sheet-header]]:pr-[3.25rem] [&_[data-slot=sheet-header]]:pb-[0.85rem] [&_[data-slot=sheet-header]]:pl-4">
        <SheetHeader>
          <SheetTitle>Conversations</SheetTitle>
          <SheetDescription>Open a recent chat or start a new one.</SheetDescription>
        </SheetHeader>
        <div className="flex-none p-3">
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={onNewConversation}
            disabled={disabled || loading || newConversationDisabled}
            aria-label="New conversation"
            className="w-full justify-start"
          >
            <MessageSquarePlus aria-hidden />
            <span>New conversation</span>
          </Button>
        </div>
        <ConversationList
          rows={rows}
          loading={loading}
          error={error}
          disabled={disabled}
          onSelectConversation={onSelectConversation}
          presentation="sheet"
          className="flex min-h-0 flex-[1_1_auto] flex-col gap-1 overflow-y-auto overscroll-contain px-3 pt-0 pb-4"
        />
        {pageError ? <span className="px-3 py-1 text-xs text-[var(--aui-danger)]">{pageError}</span> : null}
        {hasMore ? <Button type="button" variant="ghost" size="sm" onClick={onLoadMore} disabled={disabled || pageLoading} className="mx-3 mb-3">{pageLoading ? 'Loading conversations…' : pageError ? 'Try again' : 'Load more'}</Button> : null}
      </SheetContent>
    </Sheet>
    </div>
  )
}

function ConversationList({
  rows,
  loading,
  error,
  disabled,
  onSelectConversation,
  className,
  presentation = 'rail',
}: {
  rows: AssistantConversationRow[]
  loading: boolean
  error: string | null
  disabled: boolean
  onSelectConversation: (sessionId: string) => void
  className?: string
  presentation?: 'rail' | 'sheet'
}) {
  return (
    <ul className={cn('m-0 flex flex-1 list-none flex-col gap-1 overflow-y-auto px-2 pt-2 pb-0', className)} aria-label="Assistant conversation list">
      {error ? (
        <li className={cn('rounded-[0.45rem] border border-dashed border-[var(--aui-border)] p-3 text-[length:0.84rem] text-[color:var(--aui-muted)]', presentation === 'sheet' && 'rounded-[0.7rem] p-[0.8rem]')} role="status">{error}</li>
      ) : loading && rows.length === 0 ? (
        <li className={cn('rounded-[0.45rem] border border-dashed border-[var(--aui-border)] p-3 text-[length:0.84rem] text-[color:var(--aui-muted)]', presentation === 'sheet' && 'rounded-[0.7rem] p-[0.8rem]')}>Loading conversations…</li>
      ) : rows.length === 0 ? (
        <li className={cn('rounded-[0.45rem] border border-dashed border-[var(--aui-border)] p-3 text-[length:0.84rem] text-[color:var(--aui-muted)]', presentation === 'sheet' && 'rounded-[0.7rem] p-[0.8rem]')}>No conversations yet.</li>
      ) : rows.map((row) => (
        <li key={row.id}>
          <Button
            type="button"
            variant="ghost"
            aria-current={row.active ? 'true' : undefined}
            disabled={disabled || loading}
            onClick={() => onSelectConversation(row.id)}
            className={cn(
              '!flex !h-auto min-h-[4rem] w-full flex-col items-stretch justify-start gap-[0.35rem] text-left !text-[color:var(--aui-ink)] hover:bg-[color-mix(in_srgb,var(--aui-primary)_12%,var(--aui-surface-2))] hover:!text-[color:var(--aui-ink)]',
              presentation === 'sheet'
                ? 'rounded-[0.7rem] border border-transparent bg-transparent p-[0.7rem] hover:border-[color-mix(in_srgb,var(--aui-primary)_36%,var(--aui-border))]'
                : 'rounded-[0.7rem] border border-[var(--aui-border)] bg-[color-mix(in_srgb,var(--aui-surface-2)_58%,transparent)] p-[0.7rem]',
              row.active && 'border-[color-mix(in_srgb,var(--aui-primary)_36%,var(--aui-border))] bg-[color-mix(in_srgb,var(--aui-primary)_12%,var(--aui-surface-2))] !text-[color:var(--aui-ink)]'
            )}
          >
            <strong className={cn('w-full text-[color:var(--aui-ink)]', presentation === 'sheet' ? 'overflow-hidden text-ellipsis whitespace-nowrap' : 'line-clamp-2 !text-[length:0.92rem] !leading-[1.2]')}>{row.title}</strong>
            <span className={cn('flex items-center gap-2 overflow-hidden', presentation === 'sheet' ? 'w-full !text-[color:var(--aui-muted)]' : 'mt-[0.35rem] text-[length:0.78rem] !text-[color:var(--aui-ink)]')}>
              <EvidenceBadge label={row.route} />
              <time className="ml-auto whitespace-nowrap text-[length:0.72rem] text-[color:var(--aui-muted)]">{row.updated}</time>
            </span>
          </Button>
        </li>
      ))}
    </ul>
  )
}
