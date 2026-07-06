import type { MouseEventHandler, ReactNode } from 'react'
import type { AvailabilityState } from '@aurora/client'
import type { RouteAvailability } from './shell-data'
import { EvidenceBadge, PrivacyBadge, StatusBadge, presentableSignal } from './status-badges'

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

export function PageHeader({
  title,
  description,
  eyebrow = 'Route surface',
  id,
  badges,
  actions,
  className = 'aui-page-header',
  badgesLabel
}: PageHeaderProps) {
  const titleId = id ?? pageHeaderId(title)
  return (
    <header className={className} aria-labelledby={titleId}>
      <div>
        {eyebrow ? <p className="aui-kicker">{eyebrow}</p> : null}
        <h1 id={titleId}>{title}</h1>
        <p>{description}</p>
      </div>
      {badges ? (
        <div className="aui-page-header-badges" aria-label={badgesLabel ?? `${title} route badges`}>
          {badges}
        </div>
      ) : null}
      {actions ? <div className="aui-page-header-actions">{actions}</div> : null}
    </header>
  )
}

export function RouteStateNotice({ title, state, message, evidence, actionLabel }: RouteStateNoticeProps) {
  const alert = state === 'error' || state === 'permission' || state === 'offline'
  return (
    <div
      className={`aui-route-notice aui-route-notice-${state}`}
      role={alert ? 'alert' : 'status'}
      aria-live={state === 'loading' ? 'polite' : alert ? 'assertive' : undefined}
    >
      <div>
        <span className={`aui-badge aui-badge-${state}`}>{state}</span>
        <strong>{title}</strong>
      </div>
      <p>{message}</p>
      {evidence ? <code className="aui-technical-detail">{presentableSignal(evidence)}</code> : null}
      {actionLabel ? <button className="aui-button" type="button" disabled>{actionLabel}</button> : null}
    </div>
  )
}

export function RouteBadge({ route, compact = false }: RouteBadgeProps) {
  return (
    <span className={compact ? 'aui-route-badge aui-route-badge-compact' : 'aui-route-badge'} aria-label={`${route.item.label} route badge`}>
      <StatusBadge state={route.state} />
      <PrivacyBadge privacy={route.item.privacyClass} />

    </span>
  )
}

export function AdminActionButton({
  label = 'AdminAction',
  required,
  disabledReason,
  onClick
}: AdminActionButtonProps) {
  const disabled = !required || !onClick
  const reason = disabledReason ?? (required ? 'AdminAction confirmation must be requested through Aurora Auth.' : 'AdminAction is not required for this route.')
  return (
    <button
      type="button"
      className="aui-admin-action-button"
      data-admin-action-required={required ? 'true' : 'false'}
      disabled={disabled}
      title={reason}
      onClick={disabled ? undefined : onClick}
    >
      <span>{label}</span>
      <small>{required ? 'confirmation required' : 'read-only'}</small>
    </button>
  )
}

export function CapabilityDrawer({ route, title = 'Route details' }: CapabilityDrawerProps) {
  return (
    <details className="aui-capability-drawer">
      <summary>{title}</summary>
      <div className="aui-capability-drawer-body">
        <section aria-label={`${route.item.label} repair actions`}>
          <h4>Repair actions</h4>
          <div className="aui-repair-actions">
            {route.repairActions.map((action) => (
              action.disabled ? (
                <button key={action.id} type="button" className="aui-action-chip" disabled title={action.reason}>
                  {action.label}
                </button>
              ) : (
                <a key={action.id} className="aui-action-chip" href={action.href} title={action.reason}>
                  {action.label}
                </a>
              )
            ))}
          </div>
        </section>
        <section aria-label={`${route.item.label} capability blockers`}>
          <h4>Routing</h4>
          <dl>
            <div><dt>Routeable</dt><dd>{route.routeable ? 'yes' : 'no'}</dd></div>
            <div><dt>Selector</dt><dd>{route.selectorRequired ? 'required' : 'not required'}</dd></div>
            <div><dt>Approval</dt><dd>{route.approvalRequired ? 'required' : 'not required'}</dd></div>
            <div><dt>Issues</dt><dd>{presentableSignal(route.blockers.join(', ') || 'none')}</dd></div>
          </dl>
        </section>
        <section aria-label={`${route.item.label} provider candidates`}>
          <h4>Options</h4>
          {route.candidateProviders.length > 0 ? (
            <ul className="aui-provider-list">
              {route.candidateProviders.map((provider) => (
                <li key={provider.id}>
                  <span>{provider.label}</span>
                  <StatusBadge state={provider.state} />
                  <small>{provider.requiredAction ?? provider.reason}</small>
                </li>
              ))}
            </ul>
          ) : (
            <p>No alternate provider is available.</p>
          )}
        </section>
      </div>
    </details>
  )
}

export function SurfaceSkeleton({ title = 'Loading route', lines = 3 }: SurfaceSkeletonProps) {
  return (
    <section className="aui-surface-skeleton" aria-label={title} aria-live="polite">
      <span className="aui-badge aui-badge-loading">loading</span>
      {Array.from({ length: Math.max(1, lines) }, (_, index) => (
        <span key={index} className="aui-skeleton-line" />
      ))}
    </section>
  )
}

export function EmptyState({ title, message, actionLabel }: EmptyStateProps) {
  return (
    <section className="aui-empty-state">
      <h2>{title}</h2>
      <p>{message}</p>
      {actionLabel ? <button type="button" className="aui-button" disabled>{actionLabel}</button> : null}
    </section>
  )
}

export function StateSurface({ title, state, description, evidence, actionLabel }: StateSurfaceProps) {
  return (
    <section className="aui-state-surface" aria-live={state === 'loading' ? 'polite' : undefined}>
      <PageHeader
        eyebrow="System state"
        title={title}
        description={description}
        badges={state === 'loading' || state === 'error'
          ? <span className={`aui-badge aui-badge-${state}`}>{state}</span>
          : <StatusBadge state={state} />}
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
  if (state === 'loading') return 'Loading route.'
  if (state === 'error') return 'Aurora is unavailable.'
  if (state === 'offline') return 'This route is offline.'
  if (state === 'denied') return 'Permission is required for this route.'
  if (state === 'privacy-blocked') return 'Privacy or native permission is required for this route.'
  return fallback
}

function pageHeaderId(title: string): string {
  const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
  return `${slug || 'route'}-title`
}
