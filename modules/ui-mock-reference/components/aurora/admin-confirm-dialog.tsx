'use client'

import { useState } from 'react'
import { AlertTriangle, ShieldCheck } from 'lucide-react'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { Badge } from '@/components/ui/badge'
import { DiffViewer, type DiffRow } from './diff-viewer'
import { cn } from '@/lib/utils'

export type Severity = 'low' | 'medium' | 'high' | 'critical'

export interface AdminAction {
  title: string
  description: string
  methodId: string
  actionId?: string
  payloadDigest?: string
  nonce?: string
  expiresIn?: string
  confirmationMode?: 'click' | 'reason' | 'typed_phrase' | 'reauth' | 'two_admin'
  auditAvailable?: boolean
  severity: Severity
  affected: { type: string; label: string }[]
  diff?: DiffRow[]
  requireTypedPhrase?: string
  requireReason?: boolean
}

type LegacyDiffRow = DiffRow | { field: string; before: string; after: string }

const severityTone: Record<Severity, string> = {
  low: 'border-info/30 bg-info/10 text-info',
  medium: 'border-warning/30 bg-warning/10 text-warning',
  high: 'border-warning/40 bg-warning/15 text-warning',
  critical: 'border-destructive/40 bg-destructive/15 text-destructive',
}

export function AdminConfirmDialog({
  open,
  onOpenChange,
  action,
  title,
  description,
  impact,
  diff,
  confirmLabel,
  onConfirm,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  action?: AdminAction | null
  title?: string
  description?: string
  impact?: Severity
  diff?: LegacyDiffRow[]
  confirmLabel?: string
  onConfirm: (reason: string) => void
}) {
  const [phrase, setPhrase] = useState('')
  const [reason, setReason] = useState('')

  const normalizedAction: AdminAction | null = action ?? (title && description ? {
    title,
    description,
    methodId: 'AdminAction.Draft',
    severity: impact ?? 'medium',
    affected: [{ type: 'operation', label: title }],
    diff: diff?.map((row) => 'key' in row ? row : { key: row.field, before: row.before, after: row.after }),
  } : null)

  if (!normalizedAction) return null

  const actionData = {
    actionId: `draft-${normalizedAction.methodId.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')}`,
    payloadDigest: 'sha256:7e4b…f29a',
    nonce: 'nonce_9d72…31c',
    expiresIn: '5m',
    confirmationMode: normalizedAction.requireTypedPhrase ? 'typed_phrase' : normalizedAction.requireReason ? 'reason' : 'click',
    auditAvailable: true,
    ...normalizedAction,
  }

  const phraseOk = !actionData.requireTypedPhrase || phrase === actionData.requireTypedPhrase
  const reasonOk = !actionData.requireReason || reason.trim().length > 3
  const canConfirm = phraseOk && reasonOk

  function handleConfirm() {
    onConfirm(reason)
    setPhrase('')
    setReason('')
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <div className="flex items-center gap-2">
            <span
              className={cn(
                'inline-flex items-center gap-1 rounded-md border px-2 py-0.5 text-xs font-medium uppercase',
                severityTone[actionData.severity],
              )}
            >
              <AlertTriangle className="size-3.5" aria-hidden />
              {actionData.severity}
            </span>
            <code className="font-mono text-xs text-muted-foreground">{actionData.methodId}</code>
          </div>
          <DialogTitle className="pt-2">{actionData.title}</DialogTitle>
          <DialogDescription>{actionData.description}</DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="grid gap-2 rounded-lg border bg-muted/30 p-3 text-xs">
            <div className="flex items-center justify-between gap-3"><span className="text-muted-foreground">Action draft</span><code>{actionData.actionId}</code></div>
            <div className="flex items-center justify-between gap-3"><span className="text-muted-foreground">Payload digest</span><code>{actionData.payloadDigest}</code></div>
            <div className="flex items-center justify-between gap-3"><span className="text-muted-foreground">Nonce / expiry</span><code>{actionData.nonce} · {actionData.expiresIn}</code></div>
            <div className="flex items-center justify-between gap-3"><span className="text-muted-foreground">Confirmation mode</span><Badge variant="outline">{actionData.confirmationMode}</Badge></div>
            {!actionData.auditAvailable ? <Badge variant="outline" className="border-destructive/40 text-destructive">audit unavailable — block in production</Badge> : <Badge variant="outline" className="border-success/40 text-success">audit receipt required after execute</Badge>}
          </div>

          <div>
            <p className="mb-1.5 text-xs font-medium text-muted-foreground">Affected resources</p>
            <div className="flex flex-wrap gap-1.5">
              {actionData.affected.map((a) => (
                <Badge key={a.label} variant="secondary" className="font-normal">
                  <span className="text-muted-foreground">{a.type}:</span>&nbsp;{a.label}
                </Badge>
              ))}
            </div>
          </div>

          {actionData.diff && <DiffViewer rows={actionData.diff} />}

          {actionData.requireReason && (
            <div className="space-y-1.5">
              <Label htmlFor="audit-reason">Audit reason</Label>
              <Textarea
                id="audit-reason"
                placeholder="Why is this change being made? (recorded in the audit log)"
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                rows={2}
              />
            </div>
          )}

          {actionData.requireTypedPhrase && (
            <div className="space-y-1.5">
              <Label htmlFor="confirm-phrase">
                Type{' '}
                <code className="rounded bg-muted px-1 font-mono text-destructive">
                  {actionData.requireTypedPhrase}
                </code>{' '}
                to confirm
              </Label>
              <Input
                id="confirm-phrase"
                value={phrase}
                onChange={(e) => setPhrase(e.target.value)}
                autoComplete="off"
                className="font-mono"
              />
            </div>
          )}
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            variant={actionData.severity === 'critical' ? 'destructive' : 'default'}
            disabled={!canConfirm}
            onClick={handleConfirm}
          >
            <ShieldCheck className="size-4" />
            {confirmLabel ?? 'Confirm & audit'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
