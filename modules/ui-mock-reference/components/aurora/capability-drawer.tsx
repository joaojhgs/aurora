'use client'

import {
  Check,
  CircleHelp,
  Fingerprint,
  KeyRound,
  Mic,
  Plug,
  ServerCog,
  X,
} from 'lucide-react'
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet'
import { Button } from '@/components/ui/button'
import { Separator } from '@/components/ui/separator'
import { BackendCoverageBadge, CapabilityStateBadge, PrivacyBadge } from './status-badges'
import type { CapabilityFeature } from '@/lib/aurora/types'

const actionMeta: Record<string, { label: string; icon: typeof Check }> = {
  login: { label: 'Sign in', icon: KeyRound },
  pair_device: { label: 'Pair device', icon: Fingerprint },
  request_microphone: { label: 'Grant microphone', icon: Mic },
  open_settings: { label: 'Open OS settings', icon: ServerCog },
  enable_gateway: { label: 'Enable gateway', icon: Plug },
}

export function CapabilityDrawer({
  feature,
  open,
  onOpenChange,
}: {
  feature: CapabilityFeature | null
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  if (!feature) return null

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="w-full overflow-y-auto sm:max-w-md">
        <SheetHeader>
          <div className="flex items-center gap-2">
            <CircleHelp className="size-4 text-muted-foreground" aria-hidden />
            <code className="font-mono text-xs text-muted-foreground">{feature.id}</code>
          </div>
          <SheetTitle>{feature.label}</SheetTitle>
          <SheetDescription>
            Why this feature is in its current state and how to repair it.
          </SheetDescription>
        </SheetHeader>

        <div className="space-y-5 px-4 pb-6">
          <div className="flex flex-wrap items-center gap-2">
            <CapabilityStateBadge state={feature.state} />
            <PrivacyBadge privacy={feature.privacyClass} />
            <span className="rounded-full border bg-muted/60 px-2 py-0.5 text-xs capitalize text-muted-foreground">
              {feature.category}
            </span>
          </div>

          {feature.note && (
            <p className="rounded-lg border border-border bg-muted/40 p-3 text-sm text-muted-foreground">
              {feature.note}
            </p>
          )}

          {feature.backendCoverage ? <div className="space-y-2"><p className="text-xs font-medium text-muted-foreground">Backend coverage</p><BackendCoverageBadge coverage={feature.backendCoverage} /></div> : null}

          <div className="space-y-2">
            <p className="text-xs font-medium text-muted-foreground">Required services</p>
            <ul className="space-y-1.5 text-sm">
              {feature.requiredServices.map((s) => {
                const ok = !feature.missing?.some((m) => m.toLowerCase().includes(s.toLowerCase()))
                return (
                  <li key={s} className="flex items-center gap-2">
                    {ok ? (
                      <Check className="size-4 text-success" aria-hidden />
                    ) : (
                      <X className="size-4 text-destructive" aria-hidden />
                    )}
                    <span className="font-mono text-xs">{s}</span>
                  </li>
                )
              })}
            </ul>
          </div>

          {feature.requiredMethods && feature.requiredMethods.length > 0 ? (
            <div className="space-y-2">
              <p className="text-xs font-medium text-muted-foreground">Required methods</p>
              <div className="flex flex-wrap gap-1.5">
                {feature.requiredMethods.map((method) => <code key={method} className="rounded border bg-muted/60 px-1.5 py-0.5 font-mono text-xs">{method}</code>)}
              </div>
            </div>
          ) : null}

          <div className="space-y-2">
            <p className="text-xs font-medium text-muted-foreground">Required permissions</p>
            <div className="flex flex-wrap gap-1.5">
              {feature.requiredPermissions.length === 0 && (
                <span className="text-sm text-muted-foreground">None</span>
              )}
              {feature.requiredPermissions.map((p) => (
                <code
                  key={p}
                  className="rounded border bg-muted/60 px-1.5 py-0.5 font-mono text-xs"
                >
                  {p}
                </code>
              ))}
            </div>
          </div>

          {feature.transportNotes && feature.transportNotes.length > 0 ? (
            <div className="space-y-2">
              <p className="text-xs font-medium text-muted-foreground">Transport notes</p>
              <ul className="space-y-1.5 text-sm text-muted-foreground">
                {feature.transportNotes.map((note) => <li key={note}>• {note}</li>)}
              </ul>
            </div>
          ) : null}

          {feature.missing && feature.missing.length > 0 && (
            <div className="space-y-2">
              <p className="text-xs font-medium text-destructive">Missing</p>
              <ul className="space-y-1.5 text-sm">
                {feature.missing.map((m) => (
                  <li key={m} className="flex items-center gap-2">
                    <X className="size-4 text-destructive" aria-hidden />
                    {m}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {feature.userActions && feature.userActions.length > 0 && (
            <>
              <Separator />
              <div className="space-y-2">
                <p className="text-xs font-medium text-muted-foreground">Repair actions</p>
                <div className="flex flex-col gap-2">
                  {feature.userActions.map((a) => {
                    const meta = actionMeta[a] ?? { label: a, icon: CircleHelp }
                    const Icon = meta.icon
                    return (
                      <Button key={a} variant="outline" className="justify-start">
                        <Icon className="size-4" />
                        {meta.label}
                      </Button>
                    )
                  })}
                </div>
              </div>
            </>
          )}
        </div>
      </SheetContent>
    </Sheet>
  )
}
