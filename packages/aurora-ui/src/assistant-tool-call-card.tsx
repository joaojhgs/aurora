'use client'

import { CheckCircle2, ChevronDown, LoaderCircle, ShieldAlert, Wrench, XCircle } from 'lucide-react'
import { Button } from '#components/ui/button'
import { CollapsibleTrigger } from '#components/ui/collapsible'
import { ToolFallbackArgs, ToolFallbackContent, ToolFallbackResult, ToolFallbackRoot } from '#components/assistant-ui/tool-fallback'
import { cn } from '#lib/utils'
import type { AssistantApprovalGrantScope, AssistantToolCallCard } from './assistant-view'

export function AssistantToolCallCardView({
  tool,
  onResolveToolApproval
}: {
  tool: AssistantToolCallCard
  onResolveToolApproval?: ((tool: AssistantToolCallCard, approve: boolean, grantScope: AssistantApprovalGrantScope) => void) | undefined
}) {
  const statusLabel = toolStatusLabel(tool.status)
  const StatusIcon = toolStatusIcon(tool.status)
  const previewText = toolInlinePreview(tool)
  const triggerLabel = `${statusLabel}: Aurora action`
  return (
    <ToolFallbackRoot
      className="w-[min(var(--aui-chat-width),100%)] overflow-hidden rounded-[0.65rem] border border-[var(--aui-border)] bg-[color-mix(in_srgb,var(--aui-surface-2)_60%,transparent)]"
      defaultOpen={tool.status === 'requires_action'}
      aria-label="Assistant action status"
    >
      <CollapsibleTrigger className="grid max-w-full grid-cols-[auto_auto_minmax(0,1fr)_auto] items-center gap-[0.45rem] rounded-none border-0 bg-transparent px-3 py-[0.55rem] !text-[0.78rem] !leading-none text-[var(--aui-muted)] transition-[transform,border-color,background,color] duration-150 hover:bg-[color-mix(in_srgb,var(--aui-surface-2)_82%,transparent)] hover:text-[var(--aui-ink)] active:translate-y-px active:scale-[0.99] data-[state=open]:[&_.assistant-tool-chevron]:rotate-180 [@media(max-width:720px)]:grid-cols-[auto_minmax(0,1fr)_auto]" aria-label={triggerLabel}>
        <StatusIcon className={cn('size-[0.92rem]', tool.status === 'completed'
            ? 'text-[var(--aui-success)]'
            : tool.status === 'failed'
              ? 'text-[var(--aui-danger)]'
              : tool.status === 'requires_action'
                ? 'text-[var(--aui-warning)]'
                : tool.status === 'running' ? 'text-[var(--aui-primary)]' : 'text-[var(--aui-muted)]', tool.status === 'running' && 'animate-[aui-spin_0.75s_linear_infinite]')} aria-hidden />
        <span className="inline-flex min-w-0 items-center gap-[0.38rem] whitespace-nowrap [@media(max-width:720px)]:overflow-hidden">
          <span className={cn('rounded-full border border-[color-mix(in_srgb,currentColor_38%,transparent)] px-[0.38rem] py-[0.15rem] text-[0.68rem] font-extrabold uppercase', tool.status === 'completed'
            ? 'text-[var(--aui-success)]'
            : tool.status === 'failed'
              ? 'text-[var(--aui-danger)]'
              : tool.status === 'requires_action'
                ? 'text-[var(--aui-warning)]'
                : 'text-[var(--aui-primary)]')}>{statusLabel}</span>
          <strong className="font-sans text-[0.78rem] font-extrabold text-[var(--aui-ink)] [@media(max-width:720px)]:overflow-hidden [@media(max-width:720px)]:text-ellipsis">{toolTitleCopy(tool)}</strong>
        </span>
        {previewText ? <span className="min-w-0 overflow-hidden text-ellipsis whitespace-nowrap text-[var(--aui-muted)] [@media(max-width:720px)]:col-start-2 [@media(max-width:720px)]:col-end-3">{previewText}</span> : null}
        <ChevronDown aria-hidden className="assistant-tool-chevron size-[0.92rem] transition-transform duration-150" />
      </CollapsibleTrigger>
      <span className="sr-only">Action details</span>
      <dl className="sr-only">
        <div><dt>Status</dt><dd>{statusLabel}</dd></div>
        <div><dt>Account history</dt><dd>{tool.auditId ? 'Will be updated' : 'Pending'}</dd></div>
      </dl>
      <ToolFallbackContent className="m-0 rounded-none border border-x-0 border-b-0 border-t-[var(--aui-border)] bg-transparent [&>div]:flex [&>div]:flex-col [&>div]:gap-2 [&>div]:px-3 [&>div]:pb-[0.78rem] [&>div]:pt-3">
        <dl className="m-0 grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-[0.45rem] text-[0.72rem] [&_dd]:m-0 [&_dd]:mt-[0.1rem] [&_dd]:[overflow-wrap:anywhere] [&_dd]:font-mono [&_dd]:text-[0.76rem] [&_dd]:text-[var(--aui-ink)] [&_div]:contents [&_dt]:text-[0.68rem] [&_dt]:font-black [&_dt]:tracking-[0.02em] [&_dt]:text-[var(--aui-muted)] [&_dt]:uppercase">
          <div><dt>Status</dt><dd>{statusLabel}</dd></div>
          <div><dt>Review</dt><dd>{toolReviewCopy(tool)}</dd></div>
          <div><dt>Destination</dt><dd>{toolDestinationCopy(tool)}</dd></div>
          <div><dt>Data leaves device</dt><dd>{tool.dataLeavesDevice ? 'Yes' : 'No'}</dd></div>
          <div><dt>Account history</dt><dd>{tool.auditId ? 'Will be updated' : 'Pending'}</dd></div>
        </dl>
        <p className="m-0 text-[0.78rem] text-[var(--aui-muted)]">{toolSummaryCopy(tool)}</p>
        {tool.error ? (
          <div className="border-l-2 border-[var(--aui-danger)] pl-[0.65rem]">
            <p className="text-[0.68rem] font-black tracking-[0.02em] text-[var(--aui-muted)] uppercase">Action could not finish.</p>
            <p className="mt-[0.1rem] [overflow-wrap:anywhere] font-mono text-[0.76rem] text-[var(--aui-ink)]">{toolErrorCopy(tool)}</p>
          </div>
        ) : null}
        {tool.payloadPreview ? <ToolFallbackArgs argsText="Request details hidden before review." /> : null}
        {tool.resultPreview !== null && tool.resultPreview !== undefined ? <ToolFallbackResult result="Result details saved with the conversation." /> : null}
      </ToolFallbackContent>
      {tool.status === 'requires_action' ? (
        <div className="mt-2 flex flex-wrap gap-[0.35rem] border-t border-[var(--aui-border)] p-2 px-3" aria-label="Assistant action approval choices">
          <Button
            type="button"
            size="xs"
            className="min-h-[1.8rem] rounded-[0.4rem] border-transparent bg-[var(--aui-primary)] px-[0.68rem] py-[0.3rem] !text-[0.72rem] !font-semibold text-primary-foreground"
            disabled={tool.resolving || (!tool.pendingId && !tool.approvalRequestId && !tool.localConfirmationToken)}
            onClick={() => onResolveToolApproval?.(tool, true, 'once')}
          >
            Approve once
          </Button>
          <Button
            type="button"
            size="xs"
            variant="outline"
            className="min-h-[1.8rem] rounded-[0.4rem] border-transparent bg-[var(--aui-primary)] px-[0.68rem] py-[0.3rem] !text-[0.72rem] !font-semibold text-primary-foreground"
            disabled={tool.resolving || (!tool.pendingId && !tool.approvalRequestId && !tool.localConfirmationToken)}
            onClick={() => onResolveToolApproval?.(tool, true, 'session')}
          >
            Session
          </Button>
          <Button
            type="button"
            size="xs"
            variant="outline"
            className="min-h-[1.8rem] rounded-[0.4rem] border-transparent bg-[var(--aui-primary)] px-[0.68rem] py-[0.3rem] !text-[0.72rem] !font-semibold text-primary-foreground"
            disabled={tool.resolving || (!tool.pendingId && !tool.approvalRequestId && !tool.localConfirmationToken)}
            onClick={() => onResolveToolApproval?.(tool, true, 'until_expiry')}
          >
            Until expiry
          </Button>
          <Button
            type="button"
            size="xs"
            variant="outline"
            className="min-h-[1.8rem] rounded-[0.4rem] border-transparent bg-[var(--aui-primary)] px-[0.68rem] py-[0.3rem] !text-[0.72rem] !font-semibold text-primary-foreground"
            disabled={tool.resolving || (!tool.pendingId && !tool.approvalRequestId && !tool.localConfirmationToken)}
            onClick={() => onResolveToolApproval?.(tool, true, 'always')}
          >
            Always
          </Button>
          <Button
            type="button"
            size="xs"
            variant="ghost"
            className="min-h-[1.8rem] rounded-[0.4rem] px-[0.68rem] py-[0.3rem] !text-[0.72rem] !font-semibold"
            disabled={tool.resolving || (!tool.pendingId && !tool.approvalRequestId && !tool.localConfirmationToken)}
            onClick={() => onResolveToolApproval?.(tool, false, 'deny_once')}
          >
            Deny once
          </Button>
          <Button
            type="button"
            size="xs"
            variant="ghost"
            className="min-h-[1.8rem] rounded-[0.4rem] px-[0.68rem] py-[0.3rem] !text-[0.72rem] !font-semibold"
            disabled={tool.resolving || (!tool.pendingId && !tool.approvalRequestId && !tool.localConfirmationToken)}
            onClick={() => onResolveToolApproval?.(tool, false, 'deny_always')}
          >
            Block
          </Button>
        </div>
      ) : null}
    </ToolFallbackRoot>
  )
}

function toolStatusLabel(status: AssistantToolCallCard['status']): string {
  if (status === 'requires_action') return 'Needs approval'
  if (status === 'completed') return 'Done'
  if (status === 'failed') return 'Errored'
  if (status === 'running') return 'Running'
  return 'Requested'
}

function toolStatusIcon(status: AssistantToolCallCard['status']) {
  if (status === 'completed') return CheckCircle2
  if (status === 'failed') return XCircle
  if (status === 'running') return LoaderCircle
  if (status === 'requires_action') return ShieldAlert
  return Wrench
}

function toolInlinePreview(tool: AssistantToolCallCard): string | null {
  if (tool.status === 'failed') return 'Action could not finish.'
  if (tool.status === 'completed') return 'Action finished.'
  if (tool.status === 'requires_action') return 'Review before continuing.'
  if (tool.status === 'running') return 'Action is running.'
  return 'Action requested.'
}

function toolTitleCopy(tool: AssistantToolCallCard): string {
  if (tool.status === 'requires_action') return 'Action needs approval'
  if (tool.status === 'completed') return 'Action finished'
  if (tool.status === 'failed') return 'Action needs attention'
  if (tool.status === 'running') return 'Action in progress'
  return 'Assistant action'
}

function toolReviewCopy(tool: AssistantToolCallCard): string {
  if (tool.status === 'requires_action') return 'Review required'
  if (tool.status === 'failed') return 'Needs attention'
  if (tool.riskClass === 'low') return 'Standard review'
  return 'Reviewed by Aurora'
}

function toolDestinationCopy(tool: AssistantToolCallCard): string {
  return tool.dataLeavesDevice ? 'Approved destination' : 'This device'
}

function toolSummaryCopy(tool: AssistantToolCallCard): string {
  if (tool.status === 'requires_action') return 'Aurora paused this action until you approve or deny it.'
  if (tool.status === 'failed') return 'Aurora could not finish this action.'
  if (tool.status === 'completed') return 'Aurora finished this action.'
  if (tool.status === 'running') return 'Aurora is working on this action.'
  return 'Aurora requested this action.'
}

function toolErrorCopy(_tool: AssistantToolCallCard): string {
  return 'Review the conversation or account history for details.'
}
