import type { MouseEventHandler, ReactNode } from 'react'
import type { AvailabilityState } from '@aurora/client'
import { AlertTriangle, ShieldAlert } from 'lucide-react'
import type { RouteAvailability } from './shell-data'
import { EvidenceBadge, PrivacyBadge, StatusBadge, ToneBadge, presentableSignal, type BadgeTone } from './status-badges'
import { Button } from '#components/ui/button'
import { Badge } from '#components/ui/badge'
import { Skeleton } from '#components/ui/skeleton'
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from '#components/ui/empty'
import { cn } from '#lib/utils'

/**
 * Shared page chrome (page header, loading/empty/error banners, capability
 * diagnostics drawer) used across ~12 screens. Composed from real shadcn/ui primitives
 * instead of the old `.aui-*` class system -- same exported names/props as before.
 */

export interface PageHeaderProps {
  title: string
  description: string
  eyebrow?: string | null
  id?: string
  badges?: ReactNode
  actions?: ReactNode
  className?: string
  badgesLabel?: string
}

export type RouteNoticeState = 'loading' | 'empty' | 'error' | 'offline' | 'permission'

export interface RouteStateNoticeProps {
  title: string
  state: RouteNoticeState
  message: string
  evidence?: string | null | undefined
  actionLabel?: string | null | undefined
}

export interface StateSurfaceProps {
  title: string
  state: AvailabilityState | 'loading' | 'error'
  description: string
  evidence?: string | null
  actionLabel?: string | null
}

export interface RouteBadgeProps {
  route: RouteAvailability
  compact?: boolean
}

export interface AdminActionButtonProps {
  label?: string
  required: boolean
  disabledReason?: string | null | undefined
  onClick?: MouseEventHandler<HTMLButtonElement> | undefined
}

export interface CapabilityDrawerProps {
  route: RouteAvailability
  title?: string
}

export interface SurfaceSkeletonProps {
  title?: string
  lines?: number
}

export interface EmptyStateProps {
  title: string
  message: string
  actionLabel?: string | null | undefined
}

export function PageHeader({ title, description, eyebrow = 'Page', id, badges, actions, className, badgesLabel }: PageHeaderProps) {
  const titleId = id ?? pageHeaderId(title)
  return (
    <header className={cn('flex flex-wrap items-start justify-between gap-3 border-b border-border pb-4', className)} aria-labelledby={titleId}>
      <div className="flex flex-col gap-1">
        {eyebrow ? <p className="text-[10.5px] font-semibold tracking-wide text-muted-foreground uppercase">{eyebrow}</p> : null}
        <h1 id={titleId} className="text-xl font-semibold tracking-tight">
          {title}
        </h1>
        <p className="max-w-2xl text-sm text-muted-foreground">{description}</p>
      </div>
      {badges ? (
        <div className="flex flex-wrap items-center gap-1.5" aria-label={badgesLabel ?? `${title} status badges`}>
          {badges}
        </div>
      ) : null}
      {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
    </header>
  )
}

function noticeTone(state: RouteNoticeState): BadgeTone {
  if (state === 'error' || state === 'offline' || state === 'permission') return 'danger'
  if (state === 'loading') return 'neutral'
  return 'warning'
}

export function RouteStateNotice({ title, state, message, evidence, actionLabel }: RouteStateNoticeProps) {
  const alert = state === 'error' || state === 'permission' || state === 'offline'
  const tone = noticeTone(state)
  return (
    <div
      className={cn(
        'flex flex-col gap-1.5 rounded-xl border p-3.5',
        tone === 'danger' && 'border-destructive/30 bg-destructive/5',
        tone === 'warning' && 'border-warning/30 bg-warning/5',
        tone === 'neutral' && 'border-border bg-muted/30'
      )}
      role={alert ? 'alert' : 'status'}
      aria-live={state === 'loading' ? 'polite' : alert ? 'assertive' : undefined}
    >
      <div className="flex items-center gap-2">
        <ToneBadge tone={tone}>{state}</ToneBadge>
        <strong className="text-sm">{title}</strong>
      </div>
      <p className="text-sm text-muted-foreground">{message}</p>
      {evidence ? <code className="font-mono text-xs text-muted-foreground">{presentableSignal(evidence)}</code> : null}
      {actionLabel ? (
        <Button type="button" variant="outline" size="sm" disabled className="w-fit">
          {actionLabel}
        </Button>
      ) : null}
    </div>
  )
}

export function RouteBadge({ route, compact = false }: RouteBadgeProps) {
  return (
    <span className={cn('inline-flex items-center gap-1.5', compact && 'gap-1')} aria-label={`${route.item.label} status badge`}>
      <StatusBadge state={route.state} />
      <PrivacyBadge privacy={route.item.privacyClass} />
    </span>
  )
}

export function AdminActionButton({ label = 'Admin approval', required, disabledReason, onClick }: AdminActionButtonProps) {
  const disabled = !required || !onClick
  const reason = disabledReason ?? (required ? 'Admin approval must be requested through Aurora Access.' : 'Admin approval is not required for this page.')
  return (
    <Button
      type="button"
      variant="outline"
      data-admin-action-required={required ? 'true' : 'false'}
      disabled={disabled}
      title={reason}
      onClick={disabled ? undefined : onClick}
      className="flex-col items-start gap-0 py-1.5"
    >
      <span>{label}</span>
      <small className="font-normal text-muted-foreground">{required ? 'confirmation required' : 'read-only'}</small>
    </Button>
  )
}

export function CapabilityDrawer({ route, title = 'Page details' }: CapabilityDrawerProps) {
  return (
    <details className="group rounded-xl border border-border">
      <summary className="cursor-pointer list-none px-3.5 py-2.5 text-sm font-medium select-none">{title}</summary>
      <div className="flex flex-col gap-4 border-t border-border p-3.5">
        <section aria-label={`${route.item.label} repair actions`}>
          <h4 className="mb-1.5 text-xs font-semibold text-muted-foreground uppercase">Repair actions</h4>
          <div className="flex flex-wrap gap-1.5">
            {route.repairActions.map((action) =>
              action.disabled ? (
                <Badge key={action.id} variant="outline" className="cursor-not-allowed opacity-60" title={action.reason}>
                  {action.label}
                </Badge>
              ) : (
                <a key={action.id} href={action.href} title={action.reason}>
                  <Badge variant="outline" className="cursor-pointer">
                    {action.label}
                  </Badge>
                </a>
              )
            )}
          </div>
        </section>
        <section aria-label={`${route.item.label} capability blockers`}>
          <h4 className="mb-1.5 text-xs font-semibold text-muted-foreground uppercase">Readiness</h4>
          <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-sm">
            <div className="flex justify-between gap-2">
              <dt className="text-muted-foreground">Ready</dt>
              <dd>{route.routeable ? 'yes' : 'no'}</dd>
            </div>
            <div className="flex justify-between gap-2">
              <dt className="text-muted-foreground">Selector</dt>
              <dd>{route.selectorRequired ? 'required' : 'not required'}</dd>
            </div>
            <div className="flex justify-between gap-2">
              <dt className="text-muted-foreground">Approval</dt>
              <dd>{route.approvalRequired ? 'required' : 'not required'}</dd>
            </div>
            <div className="flex justify-between gap-2">
              <dt className="text-muted-foreground">Issues</dt>
              <dd>{presentableSignal(route.blockers.join(', ') || 'none')}</dd>
            </div>
          </dl>
        </section>
        <section aria-label={`${route.item.label} available options`}>
          <h4 className="mb-1.5 text-xs font-semibold text-muted-foreground uppercase">Options</h4>
          {route.candidateProviders.length > 0 ? (
            <ul className="flex flex-col gap-1.5">
              {route.candidateProviders.map((provider) => (
                <li key={provider.id} className="flex items-center gap-2 text-sm">
                  <span className="flex-1">{provider.label}</span>
                  <StatusBadge state={provider.state} />
                  <small className="text-muted-foreground">{provider.requiredAction ?? provider.reason}</small>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-muted-foreground">No other option is available.</p>
          )}
        </section>
      </div>
    </details>
  )
}

export function SurfaceSkeleton({ title = 'Loading page', lines = 3 }: SurfaceSkeletonProps) {
  return (
    <section className="flex flex-col gap-2" aria-label={title} aria-live="polite">
      <EvidenceBadge label="loading" />
      {Array.from({ length: Math.max(1, lines) }, (_, index) => (
        <Skeleton key={index} className="h-4 w-full" />
      ))}
    </section>
  )
}

export function EmptyState({ title, message, actionLabel }: EmptyStateProps) {
  return (
    <Empty>
      <EmptyHeader>
        <EmptyTitle>{title}</EmptyTitle>
        <EmptyDescription>{message}</EmptyDescription>
      </EmptyHeader>
      {actionLabel ? (
        <Button type="button" variant="outline" disabled>
          {actionLabel}
        </Button>
      ) : null}
    </Empty>
  )
}

export function StateSurface({ title, state, description, evidence, actionLabel }: StateSurfaceProps) {
  return (
    <section className="flex flex-col gap-3" aria-live={state === 'loading' ? 'polite' : undefined}>
      <PageHeader
        eyebrow="System state"
        title={title}
        description={description}
        badges={state === 'loading' || state === 'error' ? <ToneBadge tone={state === 'error' ? 'danger' : 'neutral'}>{state}</ToneBadge> : <StatusBadge state={state} />}
      />
      {evidence || actionLabel ? (
        <RouteStateNotice
          title={`${title} ${state}`}
          state={stateSurfaceNoticeState(state)}
          message={stateSurfaceMessage(state, description)}
          evidence={evidence}
          actionLabel={actionLabel}
        />
      ) : null}
    </section>
  )
}

function stateSurfaceNoticeState(state: StateSurfaceProps['state']): RouteNoticeState {
  if (state === 'loading') return 'loading'
  if (state === 'error') return 'error'
  if (state === 'offline') return 'offline'
  if (state === 'denied' || state === 'privacy-blocked') return 'permission'
  return 'empty'
}

function stateSurfaceMessage(state: StateSurfaceProps['state'], fallback: string): string {
  if (state === 'loading') return 'Loading page.'
  if (state === 'error') return 'Aurora is unavailable.'
  if (state === 'offline') return 'This page is offline.'
  if (state === 'denied') return 'Permission is required for this page.'
  if (state === 'privacy-blocked') return 'Privacy or native permission is required for this page.'
  return fallback
}

function pageHeaderId(title: string): string {
  const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
  return `${slug || 'route'}-title`
}

// re-exported for callers that want a plain shield/alert icon affordance alongside these surfaces
export { AlertTriangle, ShieldAlert }
