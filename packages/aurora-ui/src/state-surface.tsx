import type { ReactNode } from 'react'
import type { AvailabilityState } from '@aurora/client'
import { StatusBadge } from './status-badges'

export interface PageHeaderProps {
  title: string
  description: string
  eyebrow?: string
  id?: string
  badges?: ReactNode
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

export function PageHeader({
  title,
  description,
  eyebrow = 'Route surface',
  id,
  badges,
  className = 'aui-page-header',
  badgesLabel
}: PageHeaderProps) {
  const titleId = id ?? pageHeaderId(title)
  return (
    <header className={className} aria-labelledby={titleId}>
      <div>
        <p className="aui-kicker">{eyebrow}</p>
        <h1 id={titleId}>{title}</h1>
        <p>{description}</p>
      </div>
      {badges ? (
        <div className="aui-page-header-badges" aria-label={badgesLabel ?? `${title} route badges`}>
          {badges}
        </div>
      ) : null}
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
      {evidence ? <code>{evidence}</code> : null}
      {actionLabel ? <button className="aui-button" type="button" disabled>{actionLabel}</button> : null}
    </div>
  )
}

export function StateSurface({ title, state, description, evidence, actionLabel }: StateSurfaceProps) {
  return (
    <section className="aui-state-surface" aria-live={state === 'loading' ? 'polite' : undefined}>
      <PageHeader
        eyebrow="Backend state"
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
  if (state === 'loading') return 'Loading route evidence from AuroraClient.'
  if (state === 'error') return 'AuroraClient error.'
  if (state === 'offline') return 'Backend route evidence is offline.'
  if (state === 'denied') return 'Permission denied by backend policy or Auth.'
  if (state === 'privacy-blocked') return 'Privacy policy or native permission blocks this route.'
  return fallback
}

function pageHeaderId(title: string): string {
  const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
  return `${slug || 'route'}-title`
}
