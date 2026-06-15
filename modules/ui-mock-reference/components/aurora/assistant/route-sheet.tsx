'use client'

import { AlertTriangle, Check, Clock, DollarSign, Lock, ShieldCheck } from 'lucide-react'
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet'
import { Button } from '@/components/ui/button'
import { Separator } from '@/components/ui/separator'
import { cn } from '@/lib/utils'
import { routeCandidates } from '@/lib/aurora/data'
import { PrivacyBadge, RouteBadge } from '@/components/aurora/status-badges'
import type { RouteKind } from '@/lib/aurora/types'

const scopes = ['This request', 'This session', 'This feature', 'Global'] as const

const redactedPayloadPreview = {
  message: 'Summarize deployment health for <redacted-project>',
  attachments: ['service-health.json'],
  privacyClass: 'sensitive',
  strippedFields: ['token', 'raw_logs', 'peer_private_key'],
}

export function RouteSheet({
  open,
  onOpenChange,
  selected,
  onSelect,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  selected: RouteKind
  onSelect: (route: RouteKind) => void
}) {
  const selectedCandidate = routeCandidates.find((candidate) => candidate.kind === selected) ?? routeCandidates[0]

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="w-full overflow-y-auto sm:max-w-md">
        <SheetHeader>
          <SheetTitle>Route &amp; privacy</SheetTitle>
          <SheetDescription>
            Choose where this request runs. Personal data stays local-first; remote and mesh routes
            are always shown before execution.
          </SheetDescription>
        </SheetHeader>

        <div className="space-y-3 px-4">
          {routeCandidates.map((c) => {
            const active = c.kind === selected
            return (
              <button
                key={c.kind}
                type="button"
                disabled={!c.available}
                onClick={() => onSelect(c.kind)}
                className={cn(
                  'w-full rounded-lg border p-3 text-left transition-colors',
                  active
                    ? 'border-primary bg-primary/5'
                    : 'border-border hover:border-primary/40 hover:bg-accent/40',
                  !c.available && 'cursor-not-allowed opacity-50',
                )}
              >
                <div className="flex items-center justify-between gap-2">
                  <div className="flex items-center gap-2">
                    <RouteBadge route={c.kind} />
                    {active && <Check className="size-4 text-primary" aria-hidden />}
                  </div>
                  <PrivacyBadge privacy={c.privacyClass} />
                </div>
                <p className="mt-2 text-sm font-medium">{c.label}</p>
                <p className="font-mono text-xs text-muted-foreground">{c.model}</p>
                <div className="mt-2 flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
                  <span className="inline-flex items-center gap-1">
                    <Clock className="size-3.5" aria-hidden />~{(c.latencyMs / 1000).toFixed(1)}s
                  </span>
                  <span className="inline-flex items-center gap-1 capitalize">
                    <DollarSign className="size-3.5" aria-hidden />
                    {c.cost}
                  </span>
                  {!c.available && (
                    <span className="inline-flex items-center gap-1 text-warning">
                      <Lock className="size-3.5" aria-hidden />
                      unavailable
                    </span>
                  )}
                </div>
                {c.note && <p className="mt-2 text-xs text-muted-foreground">{c.note}</p>}
              </button>
            )
          })}
        </div>

        <Separator className="my-4" />

        <div className="space-y-3 px-4">
          <div className="rounded-lg border border-warning/30 bg-warning/10 p-3">
            <div className="flex items-start gap-2">
              <AlertTriangle className="mt-0.5 size-4 text-warning" aria-hidden />
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium">Sensitive route guard preview</p>
                <p className="mt-1 text-xs text-muted-foreground">
                  This is the production-required pre-dispatch shape for remote or mesh routes.
                </p>
                <div className="mt-3 grid gap-2 rounded-md border bg-background/60 p-2 font-mono text-[11px]">
                  <div className="flex justify-between gap-3"><span>target</span><span>{selectedCandidate.target ?? selectedCandidate.label}</span></div>
                  <div className="flex justify-between gap-3"><span>payload</span><span>{JSON.stringify(redactedPayloadPreview)}</span></div>
                  <div className="flex justify-between gap-3"><span>audit_id</span><span>route-preview-pending</span></div>
                  <div className="flex justify-between gap-3"><span>reason</span><span>required before dispatch</span></div>
                </div>
              </div>
            </div>
          </div>
          <div className="grid gap-2 rounded-lg border bg-muted/30 p-3 text-xs text-muted-foreground">
            <div className="flex items-center justify-between gap-3">
              <span className="inline-flex items-center gap-1.5 font-medium text-foreground">
                <ShieldCheck className="size-3.5 text-success" aria-hidden />
                Current policy
              </span>
              <span className="font-mono">privacy.allow_remote_fallback = false</span>
            </div>
            <div className="grid gap-1 sm:grid-cols-2">
              <span>Secret data: local/native only</span>
              <span>Mesh peers: trust + scope checked</span>
              <span>Admin actions: confirmation required</span>
              <span>Audit: route decision recorded</span>
            </div>
          </div>
        </div>

        <Separator className="my-4" />

        <div className="px-4">
          <p className="mb-2 text-xs font-medium text-muted-foreground">Apply preference to</p>
          <div className="grid grid-cols-2 gap-2">
            {scopes.map((s, i) => (
              <Button key={s} variant={i === 0 ? 'secondary' : 'outline'} size="sm">
                {s}
              </Button>
            ))}
          </div>
        </div>

        <SheetFooter>
          <Button onClick={() => onOpenChange(false)}>Use selected route</Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  )
}
