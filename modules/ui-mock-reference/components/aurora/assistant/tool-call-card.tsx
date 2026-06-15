'use client'

import { Check, ShieldAlert, Wrench, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import type { ToolCall } from '@/lib/aurora/types'

const riskTone: Record<ToolCall['risk'], string> = {
  'read-only': 'border-success/30 bg-success/10 text-success',
  mutating: 'border-warning/30 bg-warning/10 text-warning',
  external: 'border-warning/30 bg-warning/10 text-warning',
  admin: 'border-destructive/30 bg-destructive/10 text-destructive',
}

export function ToolCallCard({
  call,
  onDecision,
}: {
  call: ToolCall
  onDecision: (decision: 'approved' | 'denied') => void
}) {
  const decided = call.status !== 'pending'
  return (
    <div className="rounded-lg border bg-card/60 p-3">
      <div className="flex items-center gap-2">
        <Wrench className="size-4 text-primary" aria-hidden />
        <code className="font-mono text-sm font-medium">{call.name}</code>
        <span
          className={cn(
            'ml-auto rounded-full border px-2 py-0.5 text-xs font-medium capitalize',
            riskTone[call.risk],
          )}
        >
          {call.risk}
        </span>
      </div>

      <dl className="mt-3 space-y-1.5 text-sm">
        <div className="flex justify-between gap-4">
          <dt className="text-muted-foreground">Target</dt>
          <dd className="font-mono">{call.target}</dd>
        </div>
        {Object.entries(call.inputs).map(([k, v]) => (
          <div key={k} className="flex justify-between gap-4">
            <dt className="text-muted-foreground">{k}</dt>
            <dd className="truncate font-mono">{v}</dd>
          </div>
        ))}
        <div className="flex justify-between gap-4">
          <dt className="text-muted-foreground">Data leaves device</dt>
          <dd className={call.dataLeavesDevice ? 'text-warning' : 'text-success'}>
            {call.dataLeavesDevice ? 'Yes' : 'No'}
          </dd>
        </div>
      </dl>

      {decided ? (
        <div
          className={cn(
            'mt-3 flex items-center gap-1.5 rounded-md px-2 py-1.5 text-sm font-medium',
            call.status === 'approved' ? 'bg-success/10 text-success' : 'bg-destructive/10 text-destructive',
          )}
        >
          {call.status === 'approved' ? (
            <Check className="size-4" aria-hidden />
          ) : (
            <X className="size-4" aria-hidden />
          )}
          {call.status === 'approved' ? 'Approved — executing' : 'Denied'}
        </div>
      ) : (
        <div className="mt-3 flex items-center gap-2">
          <Button size="sm" onClick={() => onDecision('approved')}>
            <Check className="size-4" />
            Approve
          </Button>
          <Button size="sm" variant="outline" onClick={() => onDecision('denied')}>
            <X className="size-4" />
            Deny
          </Button>
          <span className="ml-auto inline-flex items-center gap-1 text-xs text-muted-foreground">
            <ShieldAlert className="size-3.5" aria-hidden />
            Requires approval
          </span>
        </div>
      )}
    </div>
  )
}
